import {
  receiveAtBoundary,
  type PeerAuthorize,
} from "./peer";
import type { WorkerIdentity } from "../../identity";

// Queue transport for the peer boundary. Producers enqueue through the senders
// built by peerLinks (which mint the identity-context token and wrap it beside
// the contracts-encoded envelope); consumers decode through peerReceive, which
// verifies the token and runs the Cedar authorize hook before handing the
// payload to domain code.

export type PeerQueueReceiveConfig = {
  self: WorkerIdentity;
  expectedIssuers: readonly WorkerIdentity[];
  authorize?: PeerAuthorize;
  now?: number;
};

export const peerReceive = <T>(
  body: unknown,
  decode: (bytes: Uint8Array) => T | null,
  config: PeerQueueReceiveConfig,
): Promise<T | null> =>
  receiveAtBoundary(body, decode, {
    self: config.self,
    expectedIssuers: config.expectedIssuers,
    trustZone: "peer-queue",
    authorize: config.authorize,
    now: config.now,
  });
