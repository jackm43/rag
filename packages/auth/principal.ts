// RFC-aligned identity vocabulary shared by every auth layer. This module is
// a leaf: it imports nothing, so identity, authz, and the service client can
// all depend on it without cycles.
//
// Terms follow the RFC 8693 (OAuth token exchange) request roles:
// - Principal: any authenticated identity. Humans (Discord users) and
//   machines (workers/services) are distinct Cedar entity types.
// - Subject (`sub`): the principal a request is performed on behalf of.
// - Delegate (`act`): a machine principal that has handled the request on the
//   subject's behalf; the delegation chain is ordered oldest-first.
// - Target (`aud`): the service a request is addressed to.

// Machine principals: the workers/services of this application.
//
// `dev-proxy` is the development/admin application that runs in production: a
// public edge worker (workers/public/dev-proxy) that authenticates an untrusted
// browser via Cloudflare Access + a Better Auth Discord session, then invokes the
// gateway's DevProxy service-binding entrypoint carrying the authenticated
// (Discord) subject. It occupies
// the edge zone alongside the gateway and exchanges into it; it holds its own
// Ed25519 signing key so its hops carry strong crypto identity, exactly like
// the gateway/brain. See workers/public/dev-proxy/README section in README.md.
export type MachinePrincipal = "gateway" | "brain" | "responder" | "spend" | "dev-proxy";

// The single service operation the gateway's DevProxy entrypoint accepts over
// its service binding. A dev-proxy hop frames a DevProxyCommandPayload envelope
// whose `type` is this string; the receiving boundary refuses anything else
// before Cedar or any decode runs (the registration gate). The specific command
// to run rides inside the decoded payload and is gated separately by the
// `devproxy.invoke` policy, then by the ordinary per-command `command.*` policy.
export const DEVPROXY_COMMAND_OPERATION = "devproxy.command";

// The subject used for flows with no human behind them (e.g. spend
// reconciliation kicked off by the brain itself).
export const SYSTEM_SUBJECT = "system";

// The subject of a service call plus the delegation chain accumulated so far,
// so re-minting hops can extend it (RFC 8693 `sub` + `act`).
export type Subject = {
  sub: string;
  delegates?: MachinePrincipal[];
};

// The service a request is addressed to.
export type Target = MachinePrincipal;

// Trust zones, ordered from least to most trusted:
//   untrusted (public callers) -> edge (public-facing workers)
//   -> application (internal services) -> trusted (registry, signing roots).
export type TrustZone = "untrusted" | "edge" | "application" | "trusted";

// The zone each service occupies. Every service hop carries an on-behalf-of
// token exchange regardless of whether it crosses zones; the zone pair is
// evaluated by Cedar `service.exchange` policy at client construction.
export const SERVICE_ZONE: Record<MachinePrincipal, TrustZone> = {
  gateway: "edge",
  brain: "application",
  responder: "application",
  spend: "application",
  // The dev-proxy is a public-facing worker like the gateway: it terminates an
  // untrusted browser caller (CF Access + a Better Auth Discord session) and
  // exchanges an on-behalf-of token into the gateway. Edge → edge exchange is
  // authorized by Cedar.
  "dev-proxy": "edge",
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
  brain: [
    "thread_start",
    "thread_reply",
    "channel_reply",
    "ask",
    "ragjam",
    "bicture",
    "message.received",
  ],
  responder: ["reply.channel_message", "reply.interaction_edit"],
  spend: ["spend"],
  "dev-proxy": [],
};

// How a request crossed into the receiving service.
export type Transport = "queue" | "binding" | "http";

export const isMachinePrincipal = (value: unknown): value is MachinePrincipal =>
  value === "gateway" ||
  value === "brain" ||
  value === "responder" ||
  value === "spend" ||
  value === "dev-proxy";

export const isTrustZone = (value: unknown): value is TrustZone =>
  value === "untrusted" || value === "edge" || value === "application" || value === "trusted";
