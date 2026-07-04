import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { authorizeAndForward } from "@rag/authz/forward";
import { buildIdentityContext, envelopeSha256, importSigningKey, mint, mintClaims } from "./identity";
import { errorMessage, logger } from "@rag/logger";
import { logServiceDenial, wrapServiceMessage } from "./message";
import { SERVICE_ZONE, SYSTEM_SUBJECT, type MachinePrincipal, type Subject, type Transport } from "./principal";
import { registryEntities } from "./registry";
import type { ServiceKitEnv as Env } from "./env";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import type { VerifiedRequestContext } from "./context";
import { ensureRequestPlacement, serviceHopIntent, type HopIntent } from "./control-plane";

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

// Structural doubles of the bot's ResponderAttachment and RESPONDER binding.
// The transport library stays app-agnostic; the bot's Env and attachment
// satisfy these shapes without service-kit importing app contracts.
type DeliveryAttachment = { name: string; contentType: string; data: ArrayBuffer };
type ResponderBinding = {
  deliverInteractionEdit: (
    message: ServiceMessageBytes,
    attachment: DeliveryAttachment,
  ) => Promise<void>;
};

// Structural double of the APPLICATION_AUTHORITY DO binding's mint path — only
// what the act-as opt-in needs, so service-kit stays app-agnostic (it never
// imports the platform contracts). Matches the ApplicationAuthority.mint shape.
type ActAsMintResult =
  | { ok: true; token: string; expiresIn: number }
  | { ok: false; reason: string };
type ActAsAuthorityBinding = {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => {
    mint: (input: {
      appId: string;
      member: string;
      audience: string;
      envelopeSha256: string;
      subject?: string;
    }) => Promise<ActAsMintResult>;
  };
};

// Opt-in act-as: mint an envelope-bound token asserting `self` may act as
// `appId` (optionally on behalf of `subject`) and carry it beside the hop. Only
// set on hops that need it — absent, the wire and every receiver are unchanged.
export type ActAsRequest = { appId: string; subject?: string };

export type ServiceCall =
  | {
      transport: "queue";
      queue: Queue<ServiceMessageBytes>;
      envelope: Uint8Array;
      subject: Subject;
      delaySeconds?: number;
      intent?: HopIntent;
    }
  | {
      transport: "binding";
      env: Env & { RESPONDER?: ResponderBinding };
      envelope: Uint8Array;
      attachment: DeliveryAttachment;
      subject: Subject;
      intent?: HopIntent;
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
    intent?: HopIntent,
  ) => Promise<ServiceMessageBytes>;
};

// "identity"/"application" mint a signed identity-context token beside the
// envelope. "trusted" mints a claims-only, UNSIGNED token: for a
// capability-trusted transport (service binding / queue producer the platform
// gates by config) the caller is already guaranteed, so no signing key is
// needed and the receiver (configured with the matching "trusted" transport
// mode) reads the claims without verifying a signature.
export type TransportTrust = "identity" | "application" | "trusted";

export type ServiceClientConfig = {
  self: MachinePrincipal;
  target: MachinePrincipal;
  // Lazily-resolved, memoised signing key loader, or null when the worker has
  // no signing secret provisioned (which fails the client closed: every hop
  // requires exchange material).
  signingKey: (() => Promise<CryptoKey | null>) | null;
  // "identity" and "application" mint a signed identity-context token beside
  // the envelope. "application" is the preferred name for cross-application
  // requests that must carry an application credential plus on-behalf-of
  // subject/delegation context.
  transportTrust?: TransportTrust;
  // Boundary/sidecar receivers (for example egress) still receive a signed
  // token addressed to their service binding, but they authorize the domain
  // action with their own boundary policy rather than participating in the
  // application target graph.
  authorizeExchange?: boolean;
  // Registry snapshot loader for Cedar; absent in tests.
  env?: Env;
  entities?: () => Promise<EntityJson[]>;
  // Opt-in: when set, the client mints an act-as token from the application
  // authority DO (via env.APPLICATION_AUTHORITY) and carries it beside the
  // identity token. Unset on every ordinary hop.
  actAs?: ActAsRequest;
};

// Memoise a lazily-computed promise.
const memo = <T>(create: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return () => (cached ??= create());
};

export const createServiceClient = (config: ServiceClientConfig): ServiceClient => {
  const fromZone = SERVICE_ZONE[config.self];
  const toZone = SERVICE_ZONE[config.target];
  const authorizeExchange = config.authorizeExchange ?? true;

  // Authorization for the hop, evaluated once on first use (the registry
  // snapshot is async, so this cannot run in the constructor). Cedar decides
  // whether this service may exchange into the target zone; missing signing
  // material is a denial in its own right.
  const trusted = config.transportTrust === "trusted";
  const constructionDenial = memo(async (): Promise<string | null> => {
    // A trusted (capability-gated) transport needs no signing material — the
    // binding graph is the authentication, and the token is claims-only.
    if (!trusted && config.signingKey === null) {
      return "missing_exchange_material";
    }
    if (authorizeExchange) {
      const entities = config.entities ? await config.entities() : [];
      const allowed = await authorizeAndForward(
        {
          principal: { type: "Application", id: config.self },
          action: "service.exchange",
          resource: { type: "Application", id: config.target },
          context: { fromZone, toZone },
        },
        { entities, deny: () => undefined },
        () => true,
      );
      return allowed ? null : "exchange_not_authorized";
    }
    return null;
  });

  const denyCall = (transport: Transport, reason: string): Error => {
    logServiceDenial({ identity: config.self, zone: fromZone, transport }, reason);
    return new Error(`Service call denied for ${config.self} -> ${config.target}: ${reason}`);
  };

  const mintToken = async (
    envelope: Uint8Array,
    subject: Subject,
    session?: HopSession,
    intent: HopIntent = serviceHopIntent(config.target, envelope),
  ): Promise<string | null> => {
    const key = trusted ? null : (config.signingKey ? await config.signingKey() : null);
    if (!trusted && !key) {
      return null;
    }
    const placement = await ensureRequestPlacement({
      env: config.env,
      subject,
      source: config.self,
      target: config.target,
      intent,
    });
    const context = await buildIdentityContext({
      iss: config.self,
      aud: config.target,
      sub: subject.sub,
      act: subject.delegates,
      trustZone: fromZone,
      envelopeBytes: envelope,
      requestId: placement.requestId,
      placementId: placement.placementId,
      correlationId: placement.correlationId,
      action: intent.action,
      resource: intent.resource,
      method: intent.method,
      dpopJkt: session?.dpopJkt,
      sid: session?.sid,
    });
    // Trusted transport: claims-only, unsigned (no key). Otherwise sign.
    return trusted ? mintClaims(context) : mint(key as CryptoKey, context);
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
    intent?: HopIntent,
  ): Promise<string> => {
    const denial = await constructionDenial();
    if (denial) {
      throw denyCall(transport, denial);
    }
    const token = await mintToken(envelope, subject, session, intent);
    if (token === null) {
      throw denyCall(transport, "signing_key_unavailable");
    }
    return token;
  };

  // Opt-in act-as: ask the application authority DO to mint an envelope-bound
  // token proving `self` may act as `actAs.appId`. Fails the hop closed with a
  // logged denial if the authority is unbound or refuses — the caller asked to
  // act as an application, so an unobtainable proof must not silently proceed.
  const mintActAsToken = async (
    envelope: Uint8Array,
    transport: Transport,
  ): Promise<string | undefined> => {
    if (!config.actAs) {
      return undefined;
    }
    const authority = (config.env as unknown as { APPLICATION_AUTHORITY?: ActAsAuthorityBinding } | undefined)
      ?.APPLICATION_AUTHORITY;
    if (!authority) {
      throw denyCall(transport, "actas_authority_unbound");
    }
    const result = await authority.get(authority.idFromName(config.actAs.appId)).mint({
      appId: config.actAs.appId,
      member: config.self,
      audience: config.target,
      envelopeSha256: await envelopeSha256(envelope),
      ...(config.actAs.subject ? { subject: config.actAs.subject } : {}),
    });
    if (!result.ok) {
      throw denyCall(transport, `actas_${result.reason}`);
    }
    return result.token;
  };

  const prepareBody = async (
    envelope: Uint8Array,
    subject: Subject,
    transport: Transport,
    session?: HopSession,
    intent?: HopIntent,
  ): Promise<ServiceMessageBytes> => {
    const idToken = await authorizeAndMint(envelope, subject, transport, session, intent);
    return wrapServiceMessage(envelope, idToken, await mintActAsToken(envelope, transport));
  };

  return {
    prepare: async (envelope, subject, session, intent) => {
      return prepareBody(envelope, subject, "binding", session, intent);
    },
    call: async (request) => {
      const body = await prepareBody(
        request.envelope,
        request.subject,
        request.transport,
        undefined,
        request.intent,
      );
      if (request.transport === "queue") {
        // contentType "bytes" is load-bearing: the wrapper is capnp bytes, and
        // the queue's default ("json") silently JSON-mangles a Uint8Array into
        // an index-keyed object the receiving boundary rejects.
        await request.queue.send(body, {
          contentType: "bytes",
          ...(request.delaySeconds === undefined ? {} : { delaySeconds: request.delaySeconds }),
        });
        return;
      }
      if (!request.env.RESPONDER) {
        throw new Error("RESPONDER service binding is required to send media replies");
      }
      await request.env.RESPONDER.deliverInteractionEdit(body, request.attachment);
    },
  };
};

// Import a private signing key from its secret (private JWK JSON). Absent or
// unparseable keys resolve to null so the client fails closed with a logged
// denial rather than throwing an opaque error.
const loadSigningKey = async (env: Env, secret: string): Promise<CryptoKey | null> => {
  const raw = (env as unknown as Record<string, unknown>)[secret];
  if (!raw) {
    logger.warn("service_signing_key_missing", { secret });
    return null;
  }
  if (typeof raw !== "string") {
    logger.warn("service_signing_key_invalid", { secret, error: "secret_not_string" });
    return null;
  }
  try {
    return await importSigningKey(JSON.parse(raw) as JsonWebKey);
  } catch (error) {
    logger.warn("service_signing_key_invalid", { secret, error: errorMessage(error) });
    return null;
  }
};

export type EnvServiceClientConfig = {
  self: MachinePrincipal;
  target: MachinePrincipal;
  signingSecret?: string;
  transportTrust?: TransportTrust;
  authorizeExchange?: boolean;
  actAs?: ActAsRequest;
};

type QueueServiceCall = Extract<ServiceCall, { transport: "queue" }>;
type BindingServiceCall = Extract<ServiceCall, { transport: "binding" }>;

export type ClientServiceCall =
  | Omit<QueueServiceCall, "subject">
  | Omit<BindingServiceCall, "subject">;

export type ClientPrepareOptions = {
  session?: HopSession;
  intent?: HopIntent;
};

export type ClientTarget = {
  call: (request: ClientServiceCall) => Promise<void>;
  prepare: (envelope: Uint8Array, options?: ClientPrepareOptions) => Promise<ServiceMessageBytes>;
  service: ServiceClient;
};

export type ClientConfig = {
  env: Env;
  self: MachinePrincipal;
  context: VerifiedRequestContext;
  signingSecret?: string;
  transportTrust?: TransportTrust;
};

const subjectFrom = (context: VerifiedRequestContext): Subject => {
  return {
    sub: context.subject || SYSTEM_SUBJECT,
    delegates: context.delegates,
    requestId: context.requestId,
    correlationId: context.correlationId,
  };
};

const sessionFrom = (context: VerifiedRequestContext): HopSession | undefined =>
  context.dpopJkt === undefined && context.sid === undefined
    ? undefined
    : {
        ...(context.dpopJkt !== undefined ? { dpopJkt: context.dpopJkt } : {}),
        ...(context.sid !== undefined ? { sid: context.sid } : {}),
      };

export const createClient = (config: ClientConfig) => {
  const defaultSubject = subjectFrom(config.context);
  const defaultSession = sessionFrom(config.context);
  return {
    subject: defaultSubject,
    context: config.context,
    to: (
      target: MachinePrincipal,
      options: Pick<
        EnvServiceClientConfig,
        "signingSecret" | "transportTrust" | "authorizeExchange" | "actAs"
      > = {},
    ): ClientTarget => {
      const service = createServiceClientFromEnv(config.env, {
        self: config.self,
        target,
        signingSecret: options.signingSecret ?? config.signingSecret,
        transportTrust: options.transportTrust ?? config.transportTrust,
        authorizeExchange: options.authorizeExchange,
        ...(options.actAs ? { actAs: options.actAs } : {}),
      });
      return {
        service,
        prepare: (envelope, request = {}) =>
          service.prepare(envelope, defaultSubject, request.session ?? defaultSession, request.intent),
        call: (request) =>
          service.call({
            ...request,
            subject: defaultSubject,
          } as ServiceCall),
      };
    },
  };
};

const signingSecretFor = (self: MachinePrincipal) =>
  `${self.toUpperCase().replace(/-/g, "_")}_SIGNING_KEY`;

const configuredClients = new WeakMap<Env, Map<string, ServiceClient>>();

export const createServiceClientFromEnv = (
  env: Env,
  config: EnvServiceClientConfig,
): ServiceClient => {
  let byConfig = configuredClients.get(env);
  if (!byConfig) {
    byConfig = new Map();
    configuredClients.set(env, byConfig);
  }
  const secret = config.signingSecret ?? signingSecretFor(config.self);
  const actAsKey = config.actAs ? `${config.actAs.appId}/${config.actAs.subject ?? ""}` : "";
  const key = `${config.self}->${config.target}:${secret}:${config.transportTrust ?? "identity"}:${config.authorizeExchange ?? true}:${actAsKey}`;
  const cached = byConfig.get(key);
  if (cached) {
    return cached;
  }

  const raw = (env as unknown as Record<string, unknown>)[secret];
  const signingKey = typeof raw === "string" ? memo(() => loadSigningKey(env, secret)) : null;
  const client = createServiceClient({
    self: config.self,
    target: config.target,
    signingKey,
    transportTrust: config.transportTrust,
    authorizeExchange: config.authorizeExchange,
    env,
    entities: () => registryEntities(env),
    ...(config.actAs ? { actAs: config.actAs } : {}),
  });
  byConfig.set(key, client);
  return client;
};
