import {
  receiveAtBoundary,
  type PeerAuthorize,
} from "./peer";
import { decodeReplyJobEnvelope } from "../../contracts";
import type { WorkerIdentity } from "../../identity";
import type { InteractionEditReplyJob } from "../../contracts/types";

// Service-binding RPC transport for the peer boundary: the brain hands
// media-bearing interaction edits to the responder WorkerEntrypoint directly
// because queue messages cap out at 128 KiB. Same hop shape as queue hops,
// different transport. The identity-context token rides as a sibling RPC
// argument (idToken) rather than inside the capnp envelope; the receive side
// verifies it before Cedar exactly like the queue path.
//
// The send side lives in exchange.ts (createPeerBindingSender) so minting and
// construction-time authorization are shared with the queue transport.

export type PeerBindingReceiveConfig = {
  expectedIssuers: readonly WorkerIdentity[];
  authorize?: PeerAuthorize;
  now?: number;
};

// Receive side of the binding hop: verify the identity token (aud must be the
// responder, envelope hash must match the received bytes), run the Cedar hook,
// then decode the interaction-edit envelope. Denials log the peer-binding
// context and yield null.
export const receiveResponderInteractionEdit = (
  envelope: unknown,
  idToken: string,
  config: PeerBindingReceiveConfig,
): Promise<InteractionEditReplyJob | null> =>
  receiveAtBoundary(
    // Reconstruct the wrapped shape the shared receive path expects: envelope
    // bytes + the sibling token argument.
    { envelope, idToken },
    (bytes) => {
      const job = decodeReplyJobEnvelope(bytes);
      return job?.kind === "reply.interaction_edit" ? job : null;
    },
    {
      self: "responder",
      expectedIssuers: config.expectedIssuers,
      trustZone: "peer-binding",
      authorize: config.authorize,
      now: config.now,
    },
  );
