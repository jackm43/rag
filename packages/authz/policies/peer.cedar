// Worker-to-worker delivery: the legitimate hops, one permit each. Coarse
// peer.deliver for now; service manifests refine this per envelope kind in
// the next phase.

@id("peer-gateway-to-brain")
permit (
  principal == Peer::"gateway",
  action == Action::"peer.deliver",
  resource == Service::"brain"
);

@id("peer-brain-to-responder")
permit (
  principal == Peer::"brain",
  action == Action::"peer.deliver",
  resource == Service::"responder"
);

@id("peer-brain-to-spend")
permit (
  principal == Peer::"brain",
  action == Action::"peer.deliver",
  resource == Service::"spend"
);
