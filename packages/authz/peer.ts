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

// Construction-time check for the sending side: may `sender` set up an
// identity-context exchange into `target` across the {fromZone -> toZone}
// transition? Evaluated once when a peer client is built, so an unauthorized
// pair yields a fail-closed client rather than failing per message.
export const peerExchangeAllowed = (
  sender: string,
  target: string,
  fromZone: string,
  toZone: string,
): boolean =>
  authorize({
    principal: { type: "Peer", id: sender },
    action: "peer.exchange",
    resource: { type: "Service", id: target },
    context: { fromZone, toZone },
  }).allowed;
