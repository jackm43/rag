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

@id("invoke-gateway-to-workflows")
permit (
  principal == Machine::"gateway",
  action == Action::"service.invoke",
  resource == Service::"workflows"
);

@id("invoke-workflows-to-responder")
permit (
  principal == Machine::"workflows",
  action == Action::"service.invoke",
  resource == Service::"responder"
);

@id("invoke-workflows-to-spend")
permit (
  principal == Machine::"workflows",
  action == Action::"service.invoke",
  resource == Service::"spend"
);

// The workflows worker invokes the credential broker (a connector.invoke hop). The broker
// independently gates which connector the workflows worker may touch via connectors.cedar.
@id("invoke-workflows-to-connectors")
permit (
  principal == Machine::"workflows",
  action == Action::"service.invoke",
  resource == Service::"connectors"
);

// The dev-proxy edge worker invokes the gateway's DevProxy entrypoint. The
// receiving boundary's registration gate independently constrains this to the
// gateway's one registered service operation (devproxy.command); which command
// the payload then names is gated separately by devproxy.cedar.
@id("invoke-devproxy-to-gateway")
permit (
  principal == Machine::"dev-proxy",
  action == Action::"service.invoke",
  resource == Service::"gateway"
);

// The dev-proxy is ALSO the connectors admin caller: it invokes the broker's one
// registered service operation (connector.invoke), carrying a connector.admin.*
// management op. The broker independently gates which admin op via connectors.cedar
// (dev-proxy holds no connector.grant/fetch/token permit). This is the second
// caller of the broker after the workflows worker.
@id("invoke-devproxy-to-connectors")
permit (
  principal == Machine::"dev-proxy",
  action == Action::"service.invoke",
  resource == Service::"connectors"
);

// The webhooks edge worker invokes the broker's one registered service
// operation (connector.invoke), carrying webhook_verify. The broker
// independently gates it to connector.webhook.verify on the connectors that
// have a webhook config (connectors.cedar) — the webhooks worker holds no
// grant/fetch/token permit, so this hop can never reach a credential.
@id("invoke-webhooks-to-connectors")
permit (
  principal == Machine::"webhooks",
  action == Action::"service.invoke",
  resource == Service::"connectors"
);

// The webhooks worker enqueues verified webhook events to the workflows worker (an
// on-behalf-of ServiceMessage onto the webhook queue), exactly as the gateway
// enqueues AI jobs. Which envelope kinds the workflows worker accepts is enforced by its
// registered-operation gate, not here.
@id("invoke-webhooks-to-workflows")
permit (
  principal == Machine::"webhooks",
  action == Action::"service.invoke",
  resource == Service::"workflows"
);

@id("exchange-gateway-to-workflows")
permit (
  principal == Machine::"gateway",
  action == Action::"service.exchange",
  resource == Service::"workflows"
)
when { context.fromZone == "edge" && context.toZone == "application" };

@id("exchange-workflows-to-responder")
permit (
  principal == Machine::"workflows",
  action == Action::"service.exchange",
  resource == Service::"responder"
)
when { context.fromZone == "application" && context.toZone == "application" };

@id("exchange-workflows-to-spend")
permit (
  principal == Machine::"workflows",
  action == Action::"service.exchange",
  resource == Service::"spend"
)
when { context.fromZone == "application" && context.toZone == "application" };

@id("exchange-workflows-to-connectors")
permit (
  principal == Machine::"workflows",
  action == Action::"service.exchange",
  resource == Service::"connectors"
)
when { context.fromZone == "application" && context.toZone == "application" };

// The dev-proxy exchanges an on-behalf-of token from its own edge zone into
// the gateway's edge zone (an intra-edge hop, unlike the edge→application
// gateway→workflows hop).
@id("exchange-devproxy-to-gateway")
permit (
  principal == Machine::"dev-proxy",
  action == Action::"service.exchange",
  resource == Service::"gateway"
)
when { context.fromZone == "edge" && context.toZone == "edge" };

// The dev-proxy exchanges into the connectors broker for the admin surface —
// an edge→application hop, like the gateway→workflows crossing.
@id("exchange-devproxy-to-connectors")
permit (
  principal == Machine::"dev-proxy",
  action == Action::"service.exchange",
  resource == Service::"connectors"
)
when { context.fromZone == "edge" && context.toZone == "application" };

// The webhooks worker exchanges into the connectors broker for signature
// verification — an edge→application hop, like dev-proxy→connectors.
@id("exchange-webhooks-to-connectors")
permit (
  principal == Machine::"webhooks",
  action == Action::"service.exchange",
  resource == Service::"connectors"
)
when { context.fromZone == "edge" && context.toZone == "application" };

// The webhooks worker exchanges into the workflows worker for the verified-event enqueue —
// an edge→application hop, like gateway→workflows.
@id("exchange-webhooks-to-workflows")
permit (
  principal == Machine::"webhooks",
  action == Action::"service.exchange",
  resource == Service::"workflows"
)
when { context.fromZone == "edge" && context.toZone == "application" };
