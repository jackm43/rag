import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { authorizeAndForward } from "../authz/forward";
import { buildIdentityContext, importSigningKey, mint } from "../identity";
import { errorMessage, logger } from "../logger";
import { logServiceDenial, wrapServiceMessage } from "./message";
import { SERVICE_ZONE, type MachinePrincipal, type Subject, type Transport } from "./principal";
import { registryEntities } from "./registry";
import type { Env, ResponderAttachment, ServiceMessageBytes } from "../contracts/types";

// Sending side of the service boundary, behind a single factory. A client is
// built per (self, target) hop and privately encapsulates: the Cedar
// service.exchange authorization for the zone transition, credential
// (signing-key) loading, minting the on-behalf-of identity-context token
// bound to the envelope bytes, transport selection, and denial logging. The
// caller sees only `call`.
//
// Every hop carries an on-behalf-of token exchange (RFC 8693): the subject is
// the principal the request acts for, and each hop re-mints with itself as
// issuer and the delegation chain extended. A client without signing material
// or an unauthorized hop fails closed on first use rather than per message.

export type ServiceCall =
  | {
      transport: "queue";
      queue: Queue<ServiceMessageBytes>;
      envelope: Uint8Array;
      subject: Subject;
      delaySeconds?: number;
    }
  | {
      transport: "binding";
      env: Env;
      envelope: Uint8Array;
      attachment: ResponderAttachment;
      subject: Subject;
    };

// Session-binding claims carried into the minted token for a dev-proxy edge
// hop; omitted on every service-to-service hop.
export type HopSession = {
  dpopJkt?: string;
  sid?: string;
};

export type ServiceClient = {
  call: (request: ServiceCall) => Promise<void>;
  // Run the hop's exchange authorization and mint the on-behalf-of token,
  // returning the wrapped ServiceMessage bytes — WITHOUT choosing a transport.
  // For a request/response service-binding RPC (the dev-proxy → gateway
  // DevProxy entrypoint) where the caller performs the invocation itself and
  // needs the returned value. Fails closed exactly like call(): an
  // unauthorized hop or missing signing material throws a logged denial.
  prepare: (
    envelope: Uint8Array,
    subject: Subject,
    session?: HopSession,
  ) => Promise<ServiceMessageBytes>;
};

export type ServiceClientConfig = {
  self: MachinePrincipal;
  target: MachinePrincipal;
  // Lazily-resolved, memoised signing key loader, or null when the worker has
  // no signing secret provisioned (which fails the client closed: every hop
  // requires exchange material).
  signingKey: (() => Promise<CryptoKey | null>) | null;
  // Registry snapshot loader for Cedar; absent in tests.
  entities?: () => Promise<EntityJson[]>;
};

// Memoise a lazily-computed promise.
const memo = <T>(create: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return () => (cached ??= create());
};

export const createServiceClient = (config: ServiceClientConfig): ServiceClient => {
  const fromZone = SERVICE_ZONE[config.self];
  const toZone = SERVICE_ZONE[config.target];

  // Authorization for the hop, evaluated once on first use (the registry
  // snapshot is async, so this cannot run in the constructor). Cedar decides
  // whether this service may exchange into the target zone; missing signing
  // material is a denial in its own right.
  const constructionDenial = memo(async (): Promise<string | null> => {
    if (config.signingKey === null) {
      return "missing_exchange_material";
    }
    const entities = config.entities ? await config.entities() : [];
    const allowed = await authorizeAndForward(
      {
        principal: { type: "Machine", id: config.self },
        action: "service.exchange",
        resource: { type: "Service", id: config.target },
        context: { fromZone, toZone },
      },
      { entities, deny: () => undefined },
      () => true,
    );
    return allowed ? null : "exchange_not_authorized";
  });

  const denyCall = (transport: Transport, reason: string): Error => {
    logServiceDenial({ identity: config.self, zone: fromZone, transport }, reason);
    return new Error(`Service call denied for ${config.self} -> ${config.target}: ${reason}`);
  };

  const mintToken = async (
    envelope: Uint8Array,
    subject: Subject,
    session?: HopSession,
  ): Promise<string | null> => {
    const key = config.signingKey ? await config.signingKey() : null;
    if (!key) {
      return null;
    }
    const context = await buildIdentityContext({
      iss: config.self,
      aud: config.target,
      sub: subject.sub,
      act: subject.delegates,
      trustZone: fromZone,
      envelopeBytes: envelope,
      dpopJkt: session?.dpopJkt,
      sid: session?.sid,
    });
    return mint(key, context);
  };

  // Shared credential gate for every transport: authorize the hop's zone
  // exchange (once) and mint the envelope-bound token, or throw a logged
  // denial. Both call() and prepare() go through it so authorization is never
  // skippable regardless of how the hop is transported.
  const authorizeAndMint = async (
    envelope: Uint8Array,
    subject: Subject,
    transport: Transport,
    session?: HopSession,
  ): Promise<string> => {
    const denial = await constructionDenial();
    if (denial) {
      throw denyCall(transport, denial);
    }
    const token = await mintToken(envelope, subject, session);
    if (token === null) {
      throw denyCall(transport, "signing_key_unavailable");
    }
    return token;
  };

  return {
    prepare: async (envelope, subject, session) => {
      const token = await authorizeAndMint(envelope, subject, "binding", session);
      return wrapServiceMessage(envelope, token);
    },
    call: async (request) => {
      const token = await authorizeAndMint(request.envelope, request.subject, request.transport);
      if (request.transport === "queue") {
        await request.queue.send(
          wrapServiceMessage(request.envelope, token),
          request.delaySeconds === undefined ? undefined : { delaySeconds: request.delaySeconds },
        );
        return;
      }
      if (!request.env.RESPONDER) {
        throw new Error("RESPONDER service binding is required to send media replies");
      }
      await request.env.RESPONDER.deliverInteractionEdit(request.envelope, request.attachment, token);
    },
  };
};

type SigningSecret = "GATEWAY_SIGNING_KEY" | "BRAIN_SIGNING_KEY" | "DEV_PROXY_SIGNING_KEY";

// Import a private signing key from its secret (private JWK JSON). Absent or
// unparseable keys resolve to null so the client fails closed with a logged
// denial rather than throwing an opaque error.
const loadSigningKey = async (env: Env, secret: SigningSecret): Promise<CryptoKey | null> => {
  const raw = env[secret];
  if (!raw) {
    logger.warn("service_signing_key_missing", { secret });
    return null;
  }
  try {
    return await importSigningKey(JSON.parse(raw) as JsonWebKey);
  } catch (error) {
    logger.warn("service_signing_key_invalid", { secret, error: errorMessage(error) });
    return null;
  }
};

// Per-worker service clients: the ready-to-use client for every legitimate
// hop, each pre-bound to the sending service's signing key. Only the services
// that send hold a key (gateway mints origin contexts; brain re-mints
// downstream), so a worker that never uses a given client never imports its
// (absent) key.
export type ServiceClients = {
  gatewayToBrain: ServiceClient;
  brainToResponder: ServiceClient;
  brainToSpend: ServiceClient;
  // Brain -> credential broker. The intended first caller of the connectors
  // worker; no worker binds CONNECTORS yet, so this client is constructed but
  // unused until a caller wires it (the broker's authn+authz still gate it).
  brainToConnectors: ServiceClient;
  // Dev-proxy → gateway (edge → edge), the development application's hop into
  // the gateway's DevProxy entrypoint. Only workers/public/dev-proxy holds
  // DEV_PROXY_SIGNING_KEY, so only it can construct a usable client.
  devProxyToGateway: ServiceClient;
  // Dev-proxy → connectors broker (edge → application), the admin surface's hop
  // for the connector.admin.* management ops. Same DEV_PROXY_SIGNING_KEY; the
  // broker gates which admin op via connectors.cedar.
  devProxyToConnectors: ServiceClient;
};

const buildClients = (env: Env): ServiceClients => {
  // A missing secret is passed as a null loader so the client fails closed
  // (missing_exchange_material) on first use instead of failing per send.
  const gatewayKey = env.GATEWAY_SIGNING_KEY
    ? memo(() => loadSigningKey(env, "GATEWAY_SIGNING_KEY"))
    : null;
  const brainKey = env.BRAIN_SIGNING_KEY
    ? memo(() => loadSigningKey(env, "BRAIN_SIGNING_KEY"))
    : null;
  const devProxyKey = env.DEV_PROXY_SIGNING_KEY
    ? memo(() => loadSigningKey(env, "DEV_PROXY_SIGNING_KEY"))
    : null;
  const entities = () => registryEntities(env);

  return {
    gatewayToBrain: createServiceClient({ self: "gateway", target: "brain", signingKey: gatewayKey, entities }),
    brainToResponder: createServiceClient({ self: "brain", target: "responder", signingKey: brainKey, entities }),
    brainToSpend: createServiceClient({ self: "brain", target: "spend", signingKey: brainKey, entities }),
    brainToConnectors: createServiceClient({ self: "brain", target: "connectors", signingKey: brainKey, entities }),
    devProxyToGateway: createServiceClient({ self: "dev-proxy", target: "gateway", signingKey: devProxyKey, entities }),
    devProxyToConnectors: createServiceClient({ self: "dev-proxy", target: "connectors", signingKey: devProxyKey, entities }),
  };
};

const clientsByEnv = new WeakMap<Env, ServiceClients>();

export const serviceClients = (env: Env): ServiceClients => {
  const cached = clientsByEnv.get(env);
  if (cached) {
    return cached;
  }
  const clients = buildClients(env);
  clientsByEnv.set(env, clients);
  return clients;
};
