import {
  allowAll,
  logPeerDenial,
  receiveAtBoundary,
  type PeerAuthorize,
  type PeerHop,
} from "./peer";

// Queue transport for the peer boundary. Producers enqueue contracts-encoded
// envelopes through peerSend; consumers decode through peerReceive so decode
// denials are logged with the boundary context in exactly one place.

const queueHop = (identity: string): PeerHop => ({ identity, trustZone: "peer-queue" });

export type PeerSendOptions = {
  delaySeconds?: number;
  authorize?: PeerAuthorize;
};

export const peerSend = async (
  queue: Queue<Uint8Array>,
  envelope: Uint8Array,
  identity: string,
  options: PeerSendOptions = {},
) => {
  const hop = queueHop(identity);
  if (!(options.authorize ?? allowAll)(hop)) {
    logPeerDenial(hop, "not_authorized");
    throw new Error(`Peer send denied for ${identity}`);
  }
  await queue.send(
    envelope,
    options.delaySeconds === undefined ? undefined : { delaySeconds: options.delaySeconds },
  );
};

export const peerReceive = <T>(
  body: unknown,
  decode: (body: unknown) => T | null,
  identity: string,
  authorize?: PeerAuthorize,
): T | null => receiveAtBoundary(body, decode, queueHop(identity), authorize);
