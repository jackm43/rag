// Service data-plane authorization.
//
// Two actions, one per lifecycle stage of a hop:
// - service.exchange is evaluated when a service CLIENT is constructed, with
//   the {fromZone, toZone} of the hop. It targets the destination
//   Application::<id>.
// - service.invoke is evaluated at RECEIVE time with the verified token
//   issuer as the principal, authorizing the exact Service::<app>:<operation>
//   method resource.
//
// Registry-driven policies: applications register manifests with the
// ServiceRegistry; the snapshot is merged into the entity store. There are
// intentionally no hard-coded application pairs here: adding, revoking, or
// rotating workers is a control-plane state change, not a Cedar source edit.

@id("invoke-registered")
permit (
  principal is Application,
  action == Action::"service.invoke",
  resource is Service
)
when
{
  resource has clients &&
  resource.clients.contains(principal) &&
  resource has plane &&
  resource.plane == "data" &&
  context has operation &&
  resource has operation &&
  resource.operation == context.operation
};

@id("exchange-registered")
permit (
  principal is Application,
  action == Action::"service.exchange",
  resource is Application
)
when
{
  principal has targets &&
  principal.targets.contains(resource) &&
  principal has zone &&
  context.fromZone == principal.zone &&
  resource has zone &&
  context.toZone == resource.zone
};
