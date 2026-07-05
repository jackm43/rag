// RFC-aligned identity vocabulary shared by every auth layer. This module is
// a leaf: it imports nothing, so the other identity types can depend on it
// without cycles.
//
// Terms follow the RFC 8693 (OAuth token exchange) request roles:
// - Principal: any authenticated identity (a Discord user, or one of this
//   application's workers).
// - Subject (`sub`): the principal a request is performed on behalf of.
// - Delegate (`act`): a machine principal that has handled the request on the
//   subject's behalf; the delegation chain is ordered oldest-first.

// Machine principals: the deployed workers of this application. Used as the
// subject-vocabulary for request context and as the allowed-caller keys for the
// in-process outbound egress profiles.
export type MachinePrincipal =
  | "gateway"
  | "workflows"
  | "responder"
  | "spend"
  | "webhooks";

// The subject used for flows with no human behind them (e.g. spend
// reconciliation kicked off by the workflows worker itself).
export const SYSTEM_SUBJECT = "system";

// The subject of a request plus the delegation chain accumulated so far
// (RFC 8693 `sub` + `act`).
export type Subject = {
  sub: string;
  delegates?: MachinePrincipal[];
  requestId?: string;
  correlationId?: string;
};

// Runtime domain positions, retained as a descriptive label on a verified
// request context (see context.ts). Not a caller-supplied trust assertion.
export type TrustZone = "platform" | "application" | "management" | "control-plane";

// How a request crossed into the receiving service.
export type Transport = "queue" | "binding" | "http";

export const isMachinePrincipal = (value: unknown): value is MachinePrincipal =>
  value === "gateway" ||
  value === "workflows" ||
  value === "responder" ||
  value === "spend" ||
  value === "webhooks";
