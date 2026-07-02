import {
  allowAll,
  logPeerDenial,
  receiveAtBoundary,
  type PeerAuthorize,
  type PeerHop,
} from "./peer";
import { decodeReplyJobEnvelope } from "../../contracts";
import type { Env, InteractionEditReplyJob, ResponderAttachment } from "../../contracts/types";

// Service-binding RPC transport for the peer boundary: the brain hands
// media-bearing interaction edits to the responder WorkerEntrypoint directly
// because queue messages cap out at 128 KiB. Same hop shape as queue hops,
// different transport.
const BRAIN_TO_RESPONDER: PeerHop = { identity: "brain", trustZone: "peer-binding" };

export const sendResponderInteractionEdit = async (
  env: Env,
  envelope: Uint8Array,
  attachment: ResponderAttachment,
  authorize: PeerAuthorize = allowAll,
) => {
  if (!env.RESPONDER) {
    throw new Error("RESPONDER service binding is required to send media replies");
  }
  if (!authorize(BRAIN_TO_RESPONDER)) {
    logPeerDenial(BRAIN_TO_RESPONDER, "not_authorized");
    throw new Error(`Peer send denied for ${BRAIN_TO_RESPONDER.identity}`);
  }
  await env.RESPONDER.deliverInteractionEdit(envelope, attachment);
};

// Receive side of the binding hop: the responder re-validates the capnp
// envelope (decode + value validation from contracts) exactly like a queue
// consumer would, and logs denials with the same boundary context shape.
export const receiveResponderInteractionEdit = (
  body: unknown,
  authorize?: PeerAuthorize,
): InteractionEditReplyJob | null =>
  receiveAtBoundary(
    body,
    (bytes) => {
      const job = decodeReplyJobEnvelope(bytes);
      return job?.kind === "reply.interaction_edit" ? job : null;
    },
    BRAIN_TO_RESPONDER,
    authorize,
  );
