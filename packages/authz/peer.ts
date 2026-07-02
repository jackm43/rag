import type { PeerAuthorize } from "../boundaries/peer/peer";
import { authorize } from "./authorize";

// Adapter for the peer boundary seam: the receiving worker names itself and
// Cedar decides whether the sending identity may deliver to it. Denials are
// logged by the boundary with the usual peer_denied shape.
export const peerDeliveryAuthorize =
  (receiver: string): PeerAuthorize =>
  (hop) =>
    authorize({
      principal: { type: "Peer", id: hop.identity },
      action: "peer.deliver",
      resource: { type: "Service", id: receiver },
    }).allowed;
