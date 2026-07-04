// Egress sidecar authorization.
//
// The egress worker verifies the caller's service identity first, then resolves
// the requested profile from the control-plane Durable Object for that caller's
// application. That profile is converted into an EgressSidecar resource carrying
// explicit callers. No hardcoded profile in worker code grants access.

@id("egress-sidecar-use")
permit (
  principal is Application,
  action == Action::"egress.use",
  resource is EgressSidecar
)
when
{
  resource has plane &&
  resource.plane == "data" &&
  resource has callers &&
  resource.callers.contains(principal)
};
