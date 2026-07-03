import { logger } from "../logger";
import { decodeServiceMessage, encodeServiceMessage } from "../contracts";
import type { MachinePrincipal, Transport, TrustZone } from "./principal";

// Wire shape of a service hop: a capnp ServiceMessage (service.capnp) framing
// the EventEnvelope bytes with the signed identity-context token as a sibling
// Text field. The token stays a compact JWS string (RFC 7515); capnp carries
// it, it does not redefine it. Contracts stay the source of truth for both
// the envelope and the wrapper format; this layer only names the hop.

export type ParsedServiceMessage = {
  envelope: Uint8Array;
  idToken: string | null;
};

export const wrapServiceMessage = (envelope: Uint8Array, idToken: string): Uint8Array =>
  encodeServiceMessage(envelope, idToken);

const asBytes = (value: unknown): Uint8Array | null =>
  value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;

// The pre-capnp wrapper shape ({envelope, idToken} object over structured
// clone), tolerated for messages already in flight during a deploy.
const isLegacyMessage = (value: unknown): value is { envelope?: unknown; idToken?: unknown } =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Uint8Array) &&
  !(value instanceof ArrayBuffer) &&
  "envelope" in value;

// Parse a received body into envelope bytes + token. Accepts, in order: the
// capnp ServiceMessage wrapper, the legacy object wrapper, and raw envelope
// bytes (DLQ/legacy tolerance — no token, so verification will deny).
export const parseServiceMessage = (body: unknown): ParsedServiceMessage | null => {
  if (isLegacyMessage(body)) {
    const envelope = asBytes(body.envelope);
    return envelope
      ? { envelope, idToken: typeof body.idToken === "string" ? body.idToken : null }
      : null;
  }
  const bytes = asBytes(body);
  if (!bytes) {
    return null;
  }
  const wire = decodeServiceMessage(bytes);
  return wire ?? { envelope: bytes, idToken: null };
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
