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

export type ServiceClient = {
  call: (request: ServiceCall) => Promise<void>;
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

  const mintToken = async (envelope: Uint8Array, subject: Subject): Promise<string | null> => {
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
    });
    return mint(key, context);
  };

  return {
    call: async (request) => {
      const denial = await constructionDenial();
      if (denial) {
        throw denyCall(request.transport, denial);
      }
      const token = await mintToken(request.envelope, request.subject);
      if (token === null) {
        throw denyCall(request.transport, "signing_key_unavailable");
      }
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

type SigningSecret = "GATEWAY_SIGNING_KEY" | "BRAIN_SIGNING_KEY";

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
  const entities = () => registryEntities(env);

  return {
    gatewayToBrain: createServiceClient({ self: "gateway", target: "brain", signingKey: gatewayKey, entities }),
    brainToResponder: createServiceClient({ self: "brain", target: "responder", signingKey: brainKey, entities }),
    brainToSpend: createServiceClient({ self: "brain", target: "spend", signingKey: brainKey, entities }),
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
