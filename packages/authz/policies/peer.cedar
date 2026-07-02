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

// Trust-zone TRANSITIONS: a peer client may only be CONSTRUCTED for a hop that
// crosses trust zones if policy permits the exchange. peer.exchange is evaluated
// at boundary construction (not per message) with the {fromZone, toZone} of the
// hop, so "who may exchange into which zone" lives here centrally, distinct from
// peer.deliver (which authorizes the verified delivery at receive time).

@id("peer-exchange-gateway-to-brain")
permit (
  principal == Peer::"gateway",
  action == Action::"peer.exchange",
  resource == Service::"brain"
)
when { context.fromZone == "edge" && context.toZone == "brain" };

@id("peer-exchange-brain-to-responder")
permit (
  principal == Peer::"brain",
  action == Action::"peer.exchange",
  resource == Service::"responder"
)
when { context.fromZone == "brain" && context.toZone == "egress" };

@id("peer-exchange-brain-to-spend")
permit (
  principal == Peer::"brain",
  action == Action::"peer.exchange",
  resource == Service::"spend"
)
when { context.fromZone == "brain" && context.toZone == "spend" };
