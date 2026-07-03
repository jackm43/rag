import type { MachinePrincipal, Transport, TrustZone } from "./principal";

// The verified identity context a request arrives with, derived from the
// cryptographically verified token — never from asserted fields.
export type RequestContext = {
  // The subject the request acts on behalf of (Discord user id or "system").
  subject: string;
  // Delegation chain, oldest first: every machine principal that has handled
  // the request, ending with the source.
  delegates: MachinePrincipal[];
  // The verified token issuer: the service that sent this hop.
  source: MachinePrincipal;
  // The receiving service the token was addressed to.
  target: MachinePrincipal;
  // Trust zone the token was minted from.
  zone: TrustZone;
  transport: Transport;
  // Session-binding claims present only on a dev-proxy edge hop (the token was
  // minted for a Cloudflare Access + DPoP browser session). Absent on every
  // service-to-service hop. dpopJkt is the RFC 9449 thumbprint of the browser
  // key that sender-constrained the session; sid is an opaque session id for
  // audit correlation.
  dpopJkt?: string;
  sid?: string;
};

// A received, verified, authorized, and decoded service request.
export type ServiceRequest<T> = {
  context: RequestContext;
  payload: T;
};
