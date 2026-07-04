// Gateway control-plane and management-plane authorization.
//
// Baseline:
// - control-plane is infrastructure authority over runtime state/trust
//   machinery. Gateway start/stop/health target Gateway::"control" only.
// - management is an operator/admin product surface over application resources.
//   The dev-proxy command proxy targets Gateway::"devproxy" only.
// - management actions must not operate on control-plane resources, even if a
//   later permit is accidentally too broad.

@id("gateway-management-not-control-plane")
forbid (
  principal is Application,
  action == Action::"gateway.devproxy.invoke",
  resource is Gateway
)
when
{
  resource has plane &&
  resource.plane == "control-plane"
};

@id("gateway-control-actions-only-control-plane")
forbid (
  principal is Application,
  action in [
    Action::"gateway.start",
    Action::"gateway.stop",
    Action::"gateway.health"
  ],
  resource is Gateway
)
when
{
  resource has plane &&
  resource.plane != "control-plane"
};

@id("gateway-control-application")
permit (
  principal == Application::"gateway-control",
  action in [
    Action::"gateway.start",
    Action::"gateway.stop",
    Action::"gateway.health"
  ],
  resource == Gateway::"control"
)
when
{
  resource has plane &&
  resource.plane == "control-plane"
};

@id("gateway-devproxy-commands")
permit (
  principal == Application::"dev-proxy",
  action == Action::"gateway.devproxy.invoke",
  resource == Gateway::"devproxy"
)
when
{
  resource has plane &&
  resource.plane == "management" &&
  context has command &&
  ["ask", "rag", "ragboard", "ragspend", "ragspendboard"].contains(context.command)
};
