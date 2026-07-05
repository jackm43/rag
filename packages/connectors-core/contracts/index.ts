// Connectors-owned message contracts: broker operations, webhook events, the
// dev-proxy command hop, and their result surfaces + env slice.
import * as capnp from "capnp-es";
import {
  compact,
  initEnvelope,
  isCappedText,
  isInteractionToken,
  isOptionalSnowflake,
  isOptionalUsername,
  isRecord,
  isSnowflake,
  isString,
  BASE64_PATTERN,
  optionalText,
  readEnvelope,
  textListToArray,
  type EnvelopeOptions,
} from "@rag/contracts-core";
import {
  EventEnvelope_Payload_Which,
  type ConnectorInvokePayload,
  type WebhookEventPayload,
} from "@rag/contracts-core/envelope";
import type { IngressEnv } from "@rag/ingress/env";
import type { SecretsEnv } from "@rag/secrets/env";
import type { ServiceKitEnv } from "@rag/service-kit/env";

// The uniform operations the credential broker exposes. `grant` performs the
// token exchange (returns an opaque handle, never a credential); `fetch` uses a
// handle to have the broker make the outbound call; `token` extracts a real
// short-lived token for the rare must-call-directly case; `introspect` returns a
// handle's actor context (never a secret); `begin_authorization`/
// `complete_authorization` are the 3LO seam.
export type ConnectorOperation =
  | "grant"
  | "fetch"
  | "token"
  | "introspect"
  | "begin_authorization"
  | "complete_authorization"
  // Inbound webhook signature verification (the webhooks edge worker). The
  // receiver hands the broker the provider's signature headers and the raw body
  // (base64, since signatures cover exact bytes); the broker resolves the
  // connector's webhook secret, computes the provider's HMAC scheme, and
  // returns { valid, eventId? }. The secret never leaves the broker — the same
  // phantom-token philosophy as fetch, applied inbound. Cedar-gated by
  // `connector.webhook.verify` against the connector.
  | "webhook_verify"
  // Management operations for the admin surface (the dev-proxy). These NEVER
  // touch a grant/handle and NEVER return a secret value; each is Cedar-gated by
  // a `connector.admin.*` action and audit-logged like every other broker op.
  //   admin_list      — list every connector + its secret status (no values)
  //   admin_describe  — one connector's config + status (connectorId; no values)
  //   admin_set_secret — write/point a connector's secret (connectorId; params
  //                      carry {provider, ref?, value?}); the value flows inward
  //                      only and is never echoed back
  //   admin_set_capabilities — replace a connector's application capability
  //                      lists. This is a control-plane update; it never touches
  //                      provider credentials.
  //   admin_providers — the secrets backends + their runtime write capability
  //   admin_installations — a github_app connector's App installations (id +
  //                      account + repository selection; gated by
  //                      connector.admin.read; the App JWT stays broker-side)
  | "admin_list"
  | "admin_describe"
  | "admin_set_secret"
  | "admin_set_capabilities"
  | "admin_providers"
  | "admin_installations";

// One operation against the credential broker, decoded from a connector.invoke
// EventEnvelope. `connectorId` is present on grant/authorization operations;
// `handle` on the handle-bearing operations (fetch/token/introspect). Operation-
// specific parameters ride as a JSON string in `paramsJson` (parsed and
// validated by the broker, never trusted as-is) so a new connector kind needs no
// wire-schema change.
export type ConnectorInvokeJob = {
  kind: "connector.invoke";
  operation: ConnectorOperation;
  connectorId?: string;
  handle?: string;
  subject?: string;
  scopes: string[];
  paramsJson: string;
};

// The signature schemes the webhook ingress accepts. Mirrors the broker's
// scheme set (apps/connectors/lib/webhooks.ts WebhookProvider) — kept as a
// local literal union so contracts stays a leaf package.
export type WebhookEventProvider = "github" | "stripe";

// A verified third-party webhook delivery, decoded from a webhook.event
// EventEnvelope. Encoded by the webhooks edge worker ONLY AFTER the broker's
// webhook_verify confirmed the provider signature; the workflows worker consumes it off
// the webhook-jobs queue. `eventId` is the broker-returned provider event id
// (the receiver's dedupe key) — optional because a provider may omit one (e.g.
// a Stripe body with no parseable id); `eventType` is the provider's event
// name when one travels in a header. The body rides base64 (signatures cover
// exact bytes) and is never logged.
export type WebhookEventJob = {
  kind: "webhook.event";
  connectorId: string;
  provider: WebhookEventProvider;
  eventId?: string;
  eventType?: string;
  receivedAt: string;
  bodyBase64: string;
};

// The credential broker's fail-closed result surface. Every operation returns a
// coarse HTTP-shaped `status` (200 ok, 401 unauthenticated, 403 forbidden, 404
// unknown handle/connector, 502 upstream failure, 500 internal) and, on success,
// exactly the one body field for the operation. A denial carries no detail — the
// broker logs the reason internally and never discloses which gate refused.
export type ConnectorGrantResult = {
  // The opaque phantom-token handle. High-entropy, bound to the caller principal
  // and subject; a leaked handle is useless to any other service.
  handle: string;
  connectorId: string;
  expiresAt: number;
};

export type ConnectorFetchResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type ConnectorTokenResult = {
  // A real short-lived provider token, returned ONLY for the must-call-directly
  // escape hatch (connector.token). The preferred path is fetch, where the token
  // never leaves the broker.
  value: string;
  tokenType: string;
  expiresAt?: number;
};

export type ConnectorIntrospection = {
  active: boolean;
  connectorId: string;
  callerPrincipal: string;
  subject: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
};

export type ConnectorAuthorizationBegin = {
  url: string;
  state: string;
};

// The webhook_verify result body: whether the signature verified over the exact
// body bytes, and the provider's event id (for the receiver's idempotency
// dedupe) when one travels with a VALID request. Never the secret, never the
// computed digest — a forger learns only the boolean.
export type ConnectorWebhookVerification = {
  valid: boolean;
  eventId?: string;
};

// One GitHub App installation, trimmed to the identifying fields the admin
// surface needs (the raw GitHub response stays broker-side, like every other
// provider response on an admin path).
export type ConnectorInstallation = {
  id: number;
  accountLogin: string;
  repositorySelection: string;
};

// Admin (management) result bodies. None ever carries a secret value — a
// connector's secret is described only by its {provider, ref} reference and a
// boolean "does it currently resolve". The set-secret outcome is a status
// string, not a claim of success: a backend that cannot be written at runtime
// (cloudflare-secret-store) returns `provision_required` with the exact ref to
// set out-of-band, and a deploy-time backend (wrangler-env) with a value is
// `rejected` — neither fakes success.
export type ConnectorSummary = {
  id: string;
  kind: string;
  host: string;
  // The operations the connector's kind supports (e.g. fetch/token; 3LO adds
  // authorize). Derived from the strategy, so the UI need not know kinds.
  flows: string[];
  // Whether the connector's currently-referenced secret resolves. Never the value.
  secretConfigured: boolean;
  // The backend the secret is (now) resolved through: the registry default or an
  // admin-set override.
  secretProvider: string;
};

export type ConnectorDetail = ConnectorSummary & {
  cedarResource: string;
  // The full {provider, ref} the secret is resolved through (a locator, never a
  // value). Reflects an admin override when one has been set.
  secretRef: string;
  // Whether an admin has re-pointed this connector's secret away from the
  // registry default (an override is persisted in the broker's config store).
  secretOverridden: boolean;
};

export type SecretsProviderStatus = {
  name: string;
  writable: boolean;
  configured: boolean;
};

export type SetConnectorSecretResult = {
  // written           — the value was written to the backend at runtime and the
  //                      connector re-pointed at {provider, ref}.
  // referenced        — the connector was re-pointed at an existing {provider,
  //                      ref} (no value supplied); the secret must already live
  //                      there.
  // provision_required — the connector was re-pointed, but the backend cannot be
  //                      written at runtime; `detail` states the exact ref to
  //                      provision out-of-band.
  // rejected          — the operation was refused (e.g. a value for a deploy-time
  //                      backend); `detail` says why. No mapping was persisted.
  status: "written" | "referenced" | "provision_required" | "rejected";
  connectorId: string;
  provider: string;
  ref: string;
  // Whether the connector's secret now resolves through the chosen reference.
  secretConfigured: boolean;
  // A human-readable operator message (never contains the secret value).
  detail?: string;
};

export type ConnectorResult = {
  status: number;
  grant?: ConnectorGrantResult;
  fetch?: ConnectorFetchResult;
  token?: ConnectorTokenResult;
  introspection?: ConnectorIntrospection;
  authorization?: ConnectorAuthorizationBegin;
  webhook?: ConnectorWebhookVerification;
  // Admin (management) result bodies — one per admin operation.
  connectors?: ConnectorSummary[];
  connector?: ConnectorDetail;
  providers?: SecretsProviderStatus[];
  secret?: SetConnectorSecretResult;
  installations?: ConnectorInstallation[];
};

// The connectors platform's bindings (broker, webhook ingress, dev-proxy).
export type ConnectorsEnv = {
  // Verified webhook events from the webhooks edge worker to the workflows worker
  // (producer on apps/connectors/workers/webhooks, consumer on the workflows worker), carrying
  // plain capnp EventEnvelope bytes exactly like AI_JOBS.
  WEBHOOK_JOBS?: Queue<Uint8Array>;
  // The webhooks worker's TTL'd dedupe store, a Durable Object it defines and
  // binds (apps/connectors/workers/webhooks). One object per connector; firstSeen()
  // atomically records a provider event id and reports whether it was new
  // within the replay window. Typed structurally, like SERVICE_REGISTRY.
  WEBHOOK_DEDUPE?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      firstSeen: (key: string, ttlMs: number) => Promise<boolean>;
    };
  };
  // The bot's InteractionSession processor DO, defined by the workflows worker
  // (apps/bot/workers/workflows) and bound here cross-script. The webhooks
  // ingress verifies a Discord interaction signature, returns the type-5 ack,
  // and kicks run() — which owns the entire command dispatch, so this worker
  // carries no bot domain code. The interaction is passed as an opaque payload
  // (structurally typed, mirroring WEBHOOK_DEDUPE / SERVICE_REGISTRY) so
  // contracts never imports the bot's DiscordInteraction type.
  INTERACTION_SESSION?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      run: (interaction: unknown) => Promise<void>;
    };
  };
  // Discord application public keys for interaction-signature verification,
  // keyed by application (client) id: a JSON object { "<clientId>": "<hex>" }.
  // Public keys only verify Ed25519 signatures, so this is safe to embed as a
  // wrangler var (not a secret). Resolved per {clientId} on the interactions
  // route; a future Phase-3 authority DO can supersede this static map.
  DISCORD_INTERACTION_PUBLIC_KEYS?: string;
  // The credential broker's service-binding entrypoint (apps/*/workers/
  // connectors). Bound only on the workers permitted to use a connector — no
  // worker binds it in this task; a future caller (e.g. the workflows worker) declares it.
  // A service binding is invocable solely by a worker configured with it, so this
  // RPC surface is reachable only from such a caller. Typed structurally so
  // contracts does not import worker code (mirrors RESPONDER / GATEWAY_DEVPROXY).
  CONNECTORS?: {
    invoke: (job: ConnectorInvokeJob, caller: string) => Promise<ConnectorResult>;
  };
  // The broker's own grant/token store, a Durable Object it defines and binds
  // (apps/connectors/workers/broker). Strongly consistent and persistent across
  // isolates, so a handle minted in one isolate resolves in another. Holds grant
  // entries (actor context + credential reference, never the secret) and, for
  // 3LO, per-(connector, subject) OAuth tokens. Typed structurally, like
  // SERVICE_REGISTRY.
  CONNECTOR_STORE?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      read: (key: string) => Promise<string | null>;
      write: (key: string, value: string, ttlMs?: number) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
  // GitHub App connector secrets (apps/connectors/workers/broker). GITHUB_APP_ID is
  // the numeric App id (the JWT `iss`); GITHUB_APP_PRIVATE_KEY is the App's RSA
  // private key PEM (PKCS#8 or PKCS#1). Provisioned via `wrangler secret put`;
  // see the README's one-time bootstrap for the App-creation + installation steps.
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  // The GitHub App's webhook signing secret (apps/connectors/workers/broker),
  // referenced by the github-app connector's webhook config. Used ONLY inside
  // the broker's webhook_verify HMAC — the webhooks edge worker never sees it.
  GITHUB_WEBHOOK_SECRET?: string;
  // The Discord 3LO connector's OAuth application credentials (apps/*/workers/
  // connectors) — the `discord-user` registry entry resolves both via
  // wrangler-env refs. Distinct from the dev-proxy's DISCORD_CLIENT_ID/SECRET
  // below (Better Auth login): this app is the one end users authorize so the
  // BROKER can hold their tokens; the client secret never leaves the broker.
  DISCORD_OAUTH_CLIENT_ID?: string;
  DISCORD_OAUTH_CLIENT_SECRET?: string;
  // Optional application-level AES-GCM key (base64url of 32 bytes) for the 3LO
  // OAuth token store's values-at-rest. Durable Object storage is already
  // encrypted at rest by the platform; this adds envelope encryption for the
  // stored user refresh/access tokens where an operator wants defence in depth.
  CONNECTORS_TOKEN_ENC_KEY?: string;
};

export type Env = Cloudflare.Env & ServiceKitEnv & IngressEnv & SecretsEnv & ConnectorsEnv;

// Credential-broker envelope constraints. A connector id is a short lowercase
// slug; an opaque handle is a high-entropy url-safe string; params is a JSON
// blob capped well below the 128 KiB framed-message ceiling so an
// authorizedFetch body still fits. Scopes are a small bounded list.
export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const CONNECTOR_HANDLE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
export const MAX_CONNECTOR_SUBJECT_LENGTH = 200;
export const MAX_CONNECTOR_SCOPES = 50;
export const MAX_CONNECTOR_SCOPE_LENGTH = 200;
export const MAX_CONNECTOR_PARAMS_LENGTH = 96 * 1024;
// Webhook-event envelope constraints. The raw body is capped well below the
// 128 KiB framed-message ceiling so the envelope (base64 body + metadata +
// the wrapping ServiceMessage) always fits a queue message; the receiver
// enforces the same raw-byte cap at ingress before base64ing. Event ids and
// types are short provider identifiers (a GitHub delivery GUID, a Stripe
// `evt_…` id, an event name), not free text.
export const WEBHOOK_PROVIDERS: readonly WebhookEventProvider[] = ["github", "stripe"];
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
// Base64 expansion of the raw-byte cap: 4 output chars per 3 input bytes.
export const MAX_WEBHOOK_BODY_BASE64_LENGTH = Math.ceil(MAX_WEBHOOK_BODY_BYTES / 3) * 4;
export const MAX_WEBHOOK_EVENT_ID_LENGTH = 200;
export const MAX_WEBHOOK_EVENT_TYPE_LENGTH = 100;

const CONNECTOR_OPERATIONS: readonly ConnectorOperation[] = [
  "grant",
  "fetch",
  "token",
  "introspect",
  "begin_authorization",
  "complete_authorization",
  "webhook_verify",
  "admin_list",
  "admin_describe",
  "admin_set_secret",
  "admin_set_capabilities",
  "admin_providers",
  "admin_installations",
];

const isConnectorScopes = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_CONNECTOR_SCOPES &&
  value.every(
    (scope) => isString(scope) && scope.length > 0 && scope.length <= MAX_CONNECTOR_SCOPE_LENGTH,
  );

// Wire-shape validation only: the operation is a known verb, the ids/handle
// match their character classes and caps, and exactly the right locator is
// present (a connectorId for grant/authorization, a handle for the handle-
// bearing operations). The broker parses and validates paramsJson semantically;
// here it is only length-bounded so a hostile payload cannot bloat the message.
export const validateConnectorInvokeJob = (value: unknown): value is ConnectorInvokeJob => {
  if (
    !isRecord(value) ||
    value.kind !== "connector.invoke" ||
    !isString(value.operation) ||
    !CONNECTOR_OPERATIONS.includes(value.operation as ConnectorOperation) ||
    !isString(value.paramsJson) ||
    value.paramsJson.length > MAX_CONNECTOR_PARAMS_LENGTH ||
    !isConnectorScopes(value.scopes) ||
    (value.subject !== undefined &&
      (!isString(value.subject) || value.subject.length > MAX_CONNECTOR_SUBJECT_LENGTH)) ||
    (value.connectorId !== undefined &&
      (!isString(value.connectorId) || !CONNECTOR_ID_PATTERN.test(value.connectorId))) ||
    (value.handle !== undefined &&
      (!isString(value.handle) || !CONNECTOR_HANDLE_PATTERN.test(value.handle)))
  ) {
    return false;
  }
  const operation = value.operation as ConnectorOperation;
  const usesHandle =
    operation === "fetch" || operation === "token" || operation === "introspect";
  // Broker-wide admin ops (list every connector, list the secrets backends) name
  // no single connector and bear no handle. They must carry neither locator.
  const brokerWide = operation === "admin_list" || operation === "admin_providers";
  if (brokerWide) {
    return value.connectorId === undefined && value.handle === undefined;
  }
  // A handle operation must carry a handle; every other operation (grant,
  // authorization, webhook_verify, and the per-connector admin ops
  // describe/set_secret/installations) must carry the connector it targets.
  // Fail closed on the wrong locator.
  return usesHandle
    ? isString(value.handle) && value.connectorId === undefined
    : isString(value.connectorId);
};

// Wire-shape validation for a verified webhook event: the connector id and
// provider match their vocabularies, the ids/type are capped provider
// identifiers, receivedAt is a real timestamp, and the body is well-formed
// base64 within the raw-byte cap. Applied at encode (the webhooks worker) and
// decode (the workflows worker) so neither side trusts the queue hop. The body's CONTENT
// is deliberately not inspected here — the signature was verified broker-side
// and the consumer parses it under its own rules.
export const validateWebhookEventJob = (value: unknown): value is WebhookEventJob =>
  isRecord(value) &&
  value.kind === "webhook.event" &&
  isString(value.connectorId) &&
  CONNECTOR_ID_PATTERN.test(value.connectorId) &&
  WEBHOOK_PROVIDERS.includes(value.provider as WebhookEventProvider) &&
  (value.eventId === undefined ||
    (isString(value.eventId) &&
      value.eventId.length > 0 &&
      value.eventId.length <= MAX_WEBHOOK_EVENT_ID_LENGTH)) &&
  (value.eventType === undefined ||
    (isString(value.eventType) &&
      value.eventType.length > 0 &&
      value.eventType.length <= MAX_WEBHOOK_EVENT_TYPE_LENGTH)) &&
  isString(value.receivedAt) &&
  value.receivedAt.length <= 40 &&
  !Number.isNaN(Date.parse(value.receivedAt)) &&
  isString(value.bodyBase64) &&
  value.bodyBase64.length <= MAX_WEBHOOK_BODY_BASE64_LENGTH &&
  value.bodyBase64.length % 4 === 0 &&
  BASE64_PATTERN.test(value.bodyBase64);

// The envelope `type` for a credential-broker operation. Mirrors
// CONNECTOR_INVOKE_OPERATION in packages/service-kit/principal.ts (the broker's single
// registered service operation) — kept as a literal here to avoid a
// contracts→auth import cycle, like SPEND_EVENT_TYPE and DEVPROXY_COMMAND_TYPE.
const CONNECTOR_INVOKE_TYPE = "connector.invoke";
// The envelope `type` for a verified webhook event (the webhooks worker's
// enqueue to the workflows worker). Mirrors the entry in SERVICE_OPERATIONS.workflows
// (packages/service-kit/principal.ts) — a literal here for the same no-cycle reason.
const WEBHOOK_EVENT_TYPE = "webhook.event";

export const encodeConnectorInvokeEnvelope = (
  job: ConnectorInvokeJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateConnectorInvokeJob(job)) {
    throw new Error("Invalid connector invocation for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, CONNECTOR_INVOKE_TYPE, options);
  const payload = envelope.payload._initConnectorInvoke();
  payload.operation = job.operation;
  if (job.connectorId !== undefined) {
    payload.connectorId = job.connectorId;
  }
  if (job.handle !== undefined) {
    payload.handle = job.handle;
  }
  if (job.subject !== undefined) {
    payload.subject = job.subject;
  }
  const scopeList = payload._initScopes(job.scopes.length);
  job.scopes.forEach((scope, index) => scopeList.set(index, scope));
  payload.paramsJson = job.paramsJson;
  return new Uint8Array(message.toArrayBuffer());
};

const connectorInvokeFrom = (payload: ConnectorInvokePayload): ConnectorInvokeJob =>
  compact({
    kind: "connector.invoke",
    operation: payload.operation,
    connectorId: optionalText(payload.connectorId),
    handle: optionalText(payload.handle),
    subject: optionalText(payload.subject),
    scopes: textListToArray(payload.scopes),
    paramsJson: payload.paramsJson,
  }) as ConnectorInvokeJob;

export const decodeConnectorInvokeEnvelope = (bytes: unknown): ConnectorInvokeJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.CONNECTOR_INVOKE) {
      return null;
    }
    const job = connectorInvokeFrom(envelope.payload.connectorInvoke);
    return validateConnectorInvokeJob(job) && envelope.type === CONNECTOR_INVOKE_TYPE ? job : null;
  } catch {
    return null;
  }
};

export const encodeWebhookEventEnvelope = (
  job: WebhookEventJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateWebhookEventJob(job)) {
    throw new Error("Invalid webhook event for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, WEBHOOK_EVENT_TYPE, options);
  const payload = envelope.payload._initWebhookEvent();
  payload.connectorId = job.connectorId;
  payload.provider = job.provider;
  if (job.eventId !== undefined) {
    payload.eventId = job.eventId;
  }
  if (job.eventType !== undefined) {
    payload.eventType = job.eventType;
  }
  payload.receivedAt = job.receivedAt;
  payload.bodyBase64 = job.bodyBase64;
  return new Uint8Array(message.toArrayBuffer());
};

const webhookEventFrom = (payload: WebhookEventPayload): WebhookEventJob =>
  compact({
    kind: "webhook.event",
    connectorId: payload.connectorId,
    provider: payload.provider as WebhookEventProvider,
    eventId: optionalText(payload.eventId),
    eventType: optionalText(payload.eventType),
    receivedAt: payload.receivedAt,
    bodyBase64: payload.bodyBase64,
  }) as WebhookEventJob;

export const decodeWebhookEventEnvelope = (bytes: unknown): WebhookEventJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.WEBHOOK_EVENT) {
      return null;
    }
    const job = webhookEventFrom(envelope.payload.webhookEvent);
    return validateWebhookEventJob(job) && envelope.type === WEBHOOK_EVENT_TYPE ? job : null;
  } catch {
    return null;
  }
};
