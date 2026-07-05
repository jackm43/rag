import type { MachinePrincipal, Transport, TrustZone } from "./principal";

// The minimum verified context a service client needs to create the next hop.
// Service-boundary receivers produce this from a verified identity token.
// Ingress handlers produce the same shape only after their own guard has
// authenticated the caller. The caller does not provide domain/trust-zone
// placement; the client derives that from the configured runtime worker
// (`self`) so edge/application/control-plane position stays central.
export type VerifiedRequestContext = {
  // The subject the request acts on behalf of (Discord user id or "system").
  subject: string;
  // Delegation chain, oldest first. Empty at initial ingress.
  delegates?: MachinePrincipal[];
  requestId?: string;
  correlationId?: string;
  dpopJkt?: string;
  sid?: string;
};

// The verified identity context a request arrives with, derived from the
// cryptographically verified token — never from asserted fields.
export type RequestContext = VerifiedRequestContext & {
  // The subject the request acts on behalf of (Discord user id or "system").
  subject: string;
  // Delegation chain, oldest first: every machine principal that has handled
  // the request, ending with the source.
  delegates: MachinePrincipal[];
  // The verified token issuer: the service that sent this hop.
  source: MachinePrincipal;
  // The receiving service the token was addressed to.
  target: MachinePrincipal;
  // Runtime domain position the token was minted from.
  zone: TrustZone;
  transport: Transport;
  placementId?: string;
  action?: string;
  resource?: string;
  method?: string;
};
