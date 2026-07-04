// RFC-aligned identity vocabulary shared by every auth layer. This module is
// a leaf: it imports nothing, so identity, authz, and the service client can
// all depend on it without cycles.
//
// Terms follow the RFC 8693 (OAuth token exchange) request roles:
// - Principal: any authenticated identity. Humans (Discord users) and
//   machines (apps/*/workers) are distinct Cedar entity types.
// - Subject (`sub`): the principal a request is performed on behalf of.
// - Delegate (`act`): a machine principal that has handled the request on the
//   subject's behalf; the delegation chain is ordered oldest-first.
// - Target (`aud`): the service a request is addressed to.

// Machine principals: the apps/*/workers of this application.
//
// `dev-proxy` is the development/admin application that runs in production: a
// public edge worker (apps/connectors/workers/dev-proxy) that authenticates an untrusted
// browser via Cloudflare Access + a Better Auth Discord session, then invokes the
// gateway's DevProxy service-binding entrypoint carrying the authenticated
// (Discord) subject. It occupies
// the edge zone alongside the gateway and exchanges into it; it holds its own
// Ed25519 signing key so its hops carry strong crypto identity, exactly like
// the gateway/workflows. See apps/connectors/workers/dev-proxy/README section in README.md.
//
// `connectors` is the credential broker (apps/connectors/workers/broker): the
// single home for provider credentials (GitHub App keys, API keys, OAuth
// grants). It is reachable ONLY over a service binding — no route — and today is
// mostly a verify-only receiver. When provider HTTP moves behind the generic
// Egress worker, it signs outbound egress.request hops with CONNECTORS_SIGNING_KEY.
// See apps/connectors/lib and AGENTS.md.
//
// `webhooks` is the webhook-ingress edge worker (webhooks.jsmunro.me): the
// centralised receiver third-party providers POST to (NOT behind CF Access —
// providers cannot pass it). It verifies nothing locally — signature
// verification is the broker's `connector.webhook.verify` op, so the webhook
// secret never reaches the edge — then enqueues validated events to the workflows worker,
// exactly as the gateway does. It holds its own Ed25519 signing key
// (WEBHOOKS_SIGNING_KEY) for both hops.
export type MachinePrincipal =
  | "gateway"
  | "workflows"
  | "responder"
  | "spend"
  | "registry"
  | "attest"
  | "metadata"
  | "application-service"
  | "dev-proxy"
  | "connectors"
  | "webhooks"
  | "egress";

// The single service operation the connectors broker accepts over its service
// binding. Every connector operation (fetch/token/authorize) is carried as one
// `connector.invoke` envelope whose payload names the connector, the specific
// operation, and its parameters; the receiving boundary refuses anything else
// before Cedar or any decode runs (the registration gate). Which connector the
// caller may touch, and for which operation, is gated separately by the
// `connector.*` policies against the `Connector::<id>` resource.
export const CONNECTOR_INVOKE_OPERATION = "connector.invoke";

// The generic egress proxy operation. Application workers call a bound Egress
// worker with a signed request envelope that names a configured egress profile
// (for example discord-rest or github-api); the egress worker owns the outbound
// credential injection and host policy for that profile.
export const EGRESS_REQUEST_OPERATION = "egress.request";
export const APPLICATION_REQUEST_OPERATION = "application.request";
export const REGISTRY_INVOKE_OPERATION = "registry.invoke";
export const METADATA_QUERY_OPERATION = "metadata.query";
// The single service operation attest's own service-binding entrypoint
// accepts: an HTTP-shaped GitHub webhook delivery relayed by the middleware
// client after its own edge-level method/size checks. Mirrors
// REGISTRY_INVOKE_OPERATION exactly — the specific webhook operation rides in
// the decoded payload.
export const ATTEST_INVOKE_OPERATION = "attest.invoke";

// The single service operation the gateway's DevProxy entrypoint accepts over
// its service binding. A dev-proxy hop frames a DevProxyCommandPayload envelope
// whose `type` is this string; the receiving boundary refuses anything else
// before Cedar or any decode runs (the registration gate). The specific command
// to run rides inside the decoded payload and is gated separately by the
// `devproxy.invoke` policy, then by the ordinary per-command `command.*` policy.
export const DEVPROXY_COMMAND_OPERATION = "devproxy.command";

// The subject used for flows with no human behind them (e.g. spend
// reconciliation kicked off by the workflows worker itself).
export const SYSTEM_SUBJECT = "system";

// The subject of a service call plus the delegation chain accumulated so far,
// so re-minting hops can extend it (RFC 8693 `sub` + `act`).
export type Subject = {
  sub: string;
  delegates?: MachinePrincipal[];
  requestId?: string;
  correlationId?: string;
};

// The service a request is addressed to.
export type Target = MachinePrincipal;

// Runtime domain positions. These are not caller-supplied trust assertions:
// the auth client derives a worker's position from its configured machine
// principal.
//
// Practical rules:
// - platform: public ingress workers and provider/egress boundary workers. They
//   authenticate or mediate traffic at the platform boundary.
// - application: internal product/data services that run domain workflows.
// - management: operator/admin product surfaces over application resources
//   (for example connector admin APIs or a dev-proxy admin UI). Management may
//   request control-plane changes, but it is not control-plane authority.
// - control-plane: infrastructure authority over runtime state and trust
//   machinery (service registry, request intent/placement records, revocation,
//   signing/key metadata, and authorization-affecting runtime config).
export type TrustZone = "platform" | "application" | "management" | "control-plane";

// The zone each service occupies. Every service hop carries an on-behalf-of
// token exchange regardless of whether it crosses zones; the zone pair is
// evaluated by Cedar `service.exchange` policy at client construction.
export const SERVICE_ZONE: Record<MachinePrincipal, TrustZone> = {
  gateway: "platform",
  workflows: "application",
  responder: "application",
  spend: "application",
  registry: "control-plane",
  attest: "platform",
  metadata: "application",
  "application-service": "application",
  // The dev-proxy is a public-facing worker like the gateway: it terminates an
  // untrusted browser caller (CF Access + a Better Auth Discord session) and
  // exchanges an on-behalf-of token into the gateway. Edge → edge exchange is
  // authorized by Cedar.
  "dev-proxy": "platform",
  // The credential broker is an internal application-zone service like the
  // workflows: authorized callers exchange into it from the application zone.
  connectors: "application",
  // The webhook-ingress worker terminates untrusted third-party POSTs on its
  // own subdomain, so it sits at the edge like the gateway and dev-proxy, and
  // exchanges edge → application into the broker and the workflows worker.
  webhooks: "platform",
  // Egress workers are bound per application or application cluster and hold
  // outbound provider credentials. They are not public ingress; they are a
  // credentialed egress boundary.
  egress: "platform",
};

// A service is a collection of registered operations. Each service accepts
// exactly the envelope kinds (EventEnvelope `type`) listed here and nothing
// else; the receiving boundary refuses any operation absent from its own set
// before Cedar or any payload decode runs. This is the single source of truth
// the per-service manifests declare from, so the registration a service
// advertises and the operations its boundary enforces cannot drift.
//
// The gateway's public HTTP surface (openapi.yaml) is NOT a service-boundary
// operation and is not listed here; the gateway's single registered service
// operation is the DevProxy entrypoint's `devproxy.command`, the sole hop the
// gateway accepts over a service binding (from the dev-proxy worker). The
// dev-proxy itself exposes no service boundary — its ingress is public HTTP —
// so it registers none.
export const SERVICE_OPERATIONS: Record<MachinePrincipal, readonly string[]> = {
  gateway: [DEVPROXY_COMMAND_OPERATION],
  workflows: [
    "thread_start",
    "thread_reply",
    "channel_reply",
    "ask",
    "ragjam",
    "bicture",
    "message.received",
    // A verified third-party webhook delivery enqueued by the webhooks edge
    // worker onto the webhook-jobs queue (mirroring how the gateway's chat
    // kinds above arrive on ai-jobs). Registered here so the workflows worker's boundary
    // gate, its manifest, and the registry-driven invoke policy all accept the
    // same envelope kind.
    "webhook.event",
  ],
  responder: ["reply.channel_message", "reply.interaction_edit"],
  spend: ["spend"],
  registry: [REGISTRY_INVOKE_OPERATION],
  attest: [ATTEST_INVOKE_OPERATION],
  metadata: [METADATA_QUERY_OPERATION],
  "application-service": [APPLICATION_REQUEST_OPERATION],
  "dev-proxy": [],
  // Every connector operation arrives as one `connector.invoke` envelope; the
  // specific operation (fetch/token/authorize) rides in the payload and is
  // gated per-connector by the `connector.*` policies, not at this layer.
  connectors: [CONNECTOR_INVOKE_OPERATION],
  // Like the dev-proxy, the webhooks worker's ingress is public HTTP (provider
  // webhook POSTs); it exposes no service boundary of its own, so it registers
  // no operations — it only SENDS hops (to the broker and the workflows worker).
  webhooks: [],
  egress: [EGRESS_REQUEST_OPERATION],
};

export const SERVICE_TARGETS: Record<MachinePrincipal, readonly MachinePrincipal[]> = {
  gateway: ["workflows", "application-service"],
  workflows: ["responder", "spend", "connectors"],
  responder: [],
  spend: [],
  registry: ["registry", "connectors"],
  attest: ["attest", "connectors"],
  metadata: ["metadata", "registry", "attest"],
  "application-service": [],
  "dev-proxy": ["gateway", "connectors"],
  connectors: [],
  webhooks: ["connectors", "workflows"],
  egress: [],
};

export const SERVICE_SCOPES: Record<MachinePrincipal, readonly string[]> = {
  gateway: ["gateway:control:control-plane", "gateway:devproxy:management"],
  workflows: [],
  responder: [],
  spend: [],
  registry: [],
  attest: [],
  metadata: [],
  "application-service": [],
  "dev-proxy": [],
  connectors: [],
  webhooks: [],
  egress: [],
};

// How a request crossed into the receiving service.
export type Transport = "queue" | "binding" | "http";

export const isMachinePrincipal = (value: unknown): value is MachinePrincipal =>
  value === "gateway" ||
  value === "workflows" ||
  value === "responder" ||
    value === "spend" ||
    value === "registry" ||
    value === "attest" ||
    value === "metadata" ||
    value === "application-service" ||
    value === "dev-proxy" ||
    value === "connectors" ||
    value === "webhooks" ||
    value === "egress";

export const isTrustZone = (value: unknown): value is TrustZone =>
  value === "platform" ||
  value === "application" ||
  value === "management" ||
  value === "control-plane";
