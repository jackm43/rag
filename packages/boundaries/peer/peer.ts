import { logger } from "../../logger";

// Peer trust boundary: the worker-to-worker layer. Two transports — queue
// hops and service-binding RPC — cross the same logical boundary, so every
// hop carries {identity: sending worker, trustZone} and denials log the same
// request-context shape as the inbound guards and the outbound client
// ({identity, trustZone, outcome: "denied", reason}). Contracts stay the
// source of truth for the wire format; this layer only names the hop.
export type PeerTrustZone = "peer-queue" | "peer-binding";

export type PeerHop = {
  identity: string;
  trustZone: PeerTrustZone;
};

// Authorization seam for the next phase: service manifests + Cedar policy
// checks attach here, evaluated with the hop context at every peer boundary.
// Defaults to allow; a denial is logged with the boundary context and the
// envelope never reaches domain code.
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

// Receive side shared by both transports: re-validate the envelope at the
// boundary (decode + value validation live in contracts) and run the
// authorize hook before handing the payload to domain code.
export const receiveAtBoundary = <T>(
  body: unknown,
  decode: (body: unknown) => T | null,
  hop: PeerHop,
  authorize: PeerAuthorize = allowAll,
): T | null => {
  const decoded = decode(body);
  if (decoded === null) {
    logPeerDenial(hop, "envelope_invalid");
    return null;
  }
  if (!authorize(hop)) {
    logPeerDenial(hop, "not_authorized");
    return null;
  }
  return decoded;
};
