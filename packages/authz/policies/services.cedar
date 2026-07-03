// Service-to-service authorization.
//
// Two actions, one per lifecycle stage of a hop:
// - service.exchange is evaluated when a service CLIENT is constructed, with
//   the {fromZone, toZone} of the hop. Who may exchange an on-behalf-of token
//   into which zone lives here centrally.
// - service.invoke is evaluated at RECEIVE time with the verified token
//   issuer as the principal, authorizing the delivery itself.
//
// Registry-driven policies: services register their manifests (zone, targets,
// operations) with the ServiceRegistry; the snapshot is merged into the
// entity store, so a registered pair authorizes itself through the attribute
// rules below. The static per-hop permits that follow are the bootstrap
// fallback for when the registry is empty or unreachable (fail closed to
// these exact permits, never open).

// A registered hop is permitted only for an operation the receiver registers:
// the sender must target the service, the service must list the sender as a
// client, and the invoked operation (carried in context) must be one the
// service accepts. An issuer sending an operation the receiver does not
// register is denied here as well as at the boundary's registration gate.
@id("invoke-registered")
permit (
  principal is Machine,
  action == Action::"service.invoke",
  resource is Service
)
when
{
  principal has targets &&
  principal.targets.contains(resource) &&
  resource has clients &&
  resource.clients.contains(principal) &&
  context has operation &&
  resource has operations &&
  resource.operations.contains(context.operation)
};

@id("exchange-registered")
permit (
  principal is Machine,
  action == Action::"service.exchange",
  resource is Service
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

// Bootstrap permits: the legitimate hops, one permit each.

@id("invoke-gateway-to-brain")
permit (
  principal == Machine::"gateway",
  action == Action::"service.invoke",
  resource == Service::"brain"
);

@id("invoke-brain-to-responder")
permit (
  principal == Machine::"brain",
  action == Action::"service.invoke",
  resource == Service::"responder"
);

@id("invoke-brain-to-spend")
permit (
  principal == Machine::"brain",
  action == Action::"service.invoke",
  resource == Service::"spend"
);

@id("exchange-gateway-to-brain")
permit (
  principal == Machine::"gateway",
  action == Action::"service.exchange",
  resource == Service::"brain"
)
when { context.fromZone == "edge" && context.toZone == "application" };

@id("exchange-brain-to-responder")
permit (
  principal == Machine::"brain",
  action == Action::"service.exchange",
  resource == Service::"responder"
)
when { context.fromZone == "application" && context.toZone == "application" };

@id("exchange-brain-to-spend")
permit (
  principal == Machine::"brain",
  action == Action::"service.exchange",
  resource == Service::"spend"
)
when { context.fromZone == "application" && context.toZone == "application" };
