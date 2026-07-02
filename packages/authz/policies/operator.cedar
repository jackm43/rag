// Gateway control plane: the operator (authenticated by the bearer-token
// guard) may drive the /gateway/* routes, nothing else.

@id("operator-gateway-control")
permit (
  principal == Operator::"control",
  action in [
    Action::"gateway.start",
    Action::"gateway.stop",
    Action::"gateway.health"
  ],
  resource == Gateway::"control"
);
