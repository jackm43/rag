import { logger } from "../../logger";
import {
  keyringResolver,
  verify,
  type PublicKeyResolver,
  type WorkerIdentity,
} from "../../identity";
import type { PeerQueueMessage } from "../../contracts/types";

// Peer trust boundary: the worker-to-worker layer. Two transports — queue
// hops and service-binding RPC — cross the same logical boundary, so every
// hop carries {identity: sending worker, trustZone} and denials log the same
// request-context shape as the inbound guards and the outbound client
// ({identity, trustZone, outcome: "denied", reason}). Contracts stay the
// source of truth for the wire format; this layer only names the hop.
//
// The platform guarantees the *transport* identity (a binding/queue can only
// be invoked by a worker configured with it — the bindings-as-mTLS equivalent
// described in packages/identity/token.ts). On top of that, every hop now
// carries a signed identity-context token that this boundary verifies BEFORE
// Cedar authorizes the delivery, so the principal Cedar sees is
// cryptographically established rather than merely asserted.
export type PeerTrustZone = "peer-queue" | "peer-binding";

export type PeerHop = {
  identity: string;
  trustZone: PeerTrustZone;
};

// Cedar delivery hook, evaluated with the hop context (its identity is the
// verified token issuer) after the identity token has been verified.
export type PeerAuthorize = (hop: PeerHop) => boolean;

export const allowAll: PeerAuthorize = () => true;

export const logPeerDenial = (hop: PeerHop, reason: string) => {
  logger.warn("peer_denied", {
    identity: hop.identity,
    trustZone: hop.trustZone,
    outcome: "denied",
    reason,
  });
};

export const wrapPeerMessage = (
  envelope: Uint8Array,
  idToken: string,
): PeerQueueMessage => ({ envelope, idToken });

const asBytes = (value: unknown): Uint8Array | null =>
  value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;

// A body counts as a wrapped peer message once it carries an envelope field;
// a missing/non-string idToken is then reported as identity_missing rather than
// mistaken for a malformed envelope.
const isPeerQueueMessage = (value: unknown): value is Partial<PeerQueueMessage> =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Uint8Array) &&
  !(value instanceof ArrayBuffer) &&
  "envelope" in value;

// Pull the capnp envelope bytes out of a received body, whether it is a wrapped
// peer message or (for DLQ/legacy tolerance) raw bytes.
export const peerEnvelopeBytes = (body: unknown): Uint8Array | null => {
  if (isPeerQueueMessage(body)) {
    return asBytes(body.envelope);
  }
  return asBytes(body);
};

const peerIdToken = (body: unknown): string | null =>
  isPeerQueueMessage(body) && typeof body.idToken === "string" ? body.idToken : null;

export type PeerReceiveConfig = {
  // This worker: the token audience the verifier requires.
  self: WorkerIdentity;
  // Workers whose tokens this boundary will accept.
  expectedIssuers: readonly WorkerIdentity[];
  trustZone: PeerTrustZone;
  authorize?: PeerAuthorize;
  resolver?: PublicKeyResolver;
  now?: number;
};

// Receive side shared by both transports. Order matters:
//   1. extract envelope + token from the received body
//   2. verify the identity token (signature, iss ∈ expected, aud == self,
//      exp/iat window, envelope-hash binding) — a cryptographic gate
//   3. run the Cedar authorize hook with the VERIFIED issuer as the principal
//   4. decode + value-validate the envelope (contracts)
// Any failure logs the shared peer_denied shape and returns null; nothing
// reaches domain code, and the message is acked/dropped by the caller.
export const receiveAtBoundary = async <T>(
  body: unknown,
  decode: (body: Uint8Array) => T | null,
  config: PeerReceiveConfig,
): Promise<T | null> => {
  const fallbackIdentity = config.expectedIssuers[0] ?? "unknown";
  const envelope = peerEnvelopeBytes(body);
  if (!envelope) {
    logPeerDenial({ identity: fallbackIdentity, trustZone: config.trustZone }, "envelope_invalid");
    return null;
  }

  const idToken = peerIdToken(body);
  if (idToken === null) {
    logPeerDenial({ identity: fallbackIdentity, trustZone: config.trustZone }, "identity_missing");
    return null;
  }

  const result = await verify(config.resolver ?? keyringResolver, idToken, {
    expectedAud: config.self,
    expectedIssuers: config.expectedIssuers,
    envelopeBytes: envelope,
    now: config.now,
  });
  if (!result.ok) {
    logPeerDenial(
      { identity: fallbackIdentity, trustZone: config.trustZone },
      `identity_${result.reason}`,
    );
    return null;
  }

  // The verified issuer is the cryptographically-trusted peer principal Cedar
  // now decides on (replacing the previously-asserted sender string). The
  // on-behalf-of user rides in result.context.sub for downstream attribution.
  const hop: PeerHop = { identity: result.context.iss, trustZone: config.trustZone };
  if (!(config.authorize ?? allowAll)(hop)) {
    logPeerDenial(hop, "not_authorized");
    return null;
  }

  const decoded = decode(envelope);
  if (decoded === null) {
    logPeerDenial(hop, "envelope_invalid");
    return null;
  }
  return decoded;
};
