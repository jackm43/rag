import { logger } from "@rag/logger";
import { decodeServiceMessage, encodeServiceMessage } from "@rag/contracts-core";
import type { MachinePrincipal, Transport, TrustZone } from "./principal";

// Wire shape of a service hop: a capnp ServiceMessage (service.capnp) framing
// the EventEnvelope bytes with the signed identity-context token as a sibling
// Text field. The token stays a compact JWS string (RFC 7515); capnp carries
// it, it does not redefine it. Contracts stay the source of truth for both
// the envelope and the wrapper format; this layer only names the hop.

export type ParsedServiceMessage = {
  envelope: Uint8Array;
  idToken: string;
  // Present only when the hop carries an act-as claim (opt-in on both ends).
  actAsToken?: string;
};

export const wrapServiceMessage = (
  envelope: Uint8Array,
  idToken: string,
  actAsToken?: string,
): Uint8Array => encodeServiceMessage(envelope, idToken, actAsToken);

// Parse a received body into envelope bytes + token. The service boundary only
// accepts the capnp ServiceMessage wrapper; callers must not send raw envelopes
// or structured-clone objects.
export const parseServiceMessage = (body: unknown): ParsedServiceMessage | null => {
  const bytes = body instanceof Uint8Array
    ? body
    : body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : null;
  if (!bytes) {
    return null;
  }
  return decodeServiceMessage(bytes);
};

// Pull just the capnp envelope bytes out of a received body (DLQ logging).
export const serviceEnvelopeBytes = (body: unknown): Uint8Array | null =>
  parseServiceMessage(body)?.envelope ?? null;

// Shared denial log shape for the service boundary — matches the ingress
// guards and the outbound boundary client ({identity, zone, transport,
// outcome, reason}) so denials read the same at every boundary.
export const logServiceDenial = (
  hop: { identity: MachinePrincipal | "unknown"; zone: TrustZone; transport: Transport },
  reason: string,
) => {
  logger.warn("service_denied", {
    identity: hop.identity,
    zone: hop.zone,
    transport: hop.transport,
    outcome: "denied",
    reason,
  });
};
