// Connector data and management-plane authorization.
//
// Connector resources are dynamic control-plane data. The broker materializes
// Connector entities from its connector registry/control store at authorization
// time. Cedar stays generic: it checks the requested operation against the
// caller lists on the Connector entity, not hardcoded application/connector
// pairs in policy source.
//
// Baseline:
// - connector.grant/fetch/token/authorize/webhook.verify are data-plane
//   operations over usable connector resources.
// - connector.admin.* is a management-plane operator surface over connector
//   configuration; it may request changes but is not control-plane authority.
// - management actions must not operate on control-plane resources, even if a
//   later permit is accidentally too broad.

@id("connector-management-not-control-plane")
forbid (
  principal is Application,
  action in [
    Action::"connector.admin.list",
    Action::"connector.admin.read",
    Action::"connector.admin.write"
  ],
  resource is Connector
)
when
{
  resource has plane &&
  resource.plane == "control-plane"
};

@id("connector-data-actions-only-data-plane")
forbid (
  principal is Application,
  action in [
    Action::"connector.grant",
    Action::"connector.fetch",
    Action::"connector.token",
    Action::"connector.authorize",
    Action::"connector.webhook.verify"
  ],
  resource is Connector
)
when
{
  resource has plane &&
  resource.plane != "data" &&
  !(
    resource has planes &&
    resource.planes.contains("data")
  )
};

@id("connector-grant")
permit (
  principal is Application,
  action == Action::"connector.grant",
  resource is Connector
)
when { resource has grant && resource.grant.contains(principal) };

@id("connector-fetch")
permit (
  principal is Application,
  action == Action::"connector.fetch",
  resource is Connector
)
when { resource has fetch && resource.fetch.contains(principal) };

@id("connector-token")
permit (
  principal is Application,
  action == Action::"connector.token",
  resource is Connector
)
when { resource has token && resource.token.contains(principal) };

@id("connector-authorize")
permit (
  principal is Application,
  action == Action::"connector.authorize",
  resource is Connector
)
when { resource has authorize && resource.authorize.contains(principal) };

@id("connector-webhook-verify")
permit (
  principal is Application,
  action == Action::"connector.webhook.verify",
  resource is Connector
)
when { resource has webhookVerify && resource.webhookVerify.contains(principal) };

@id("connector-admin-list")
permit (
  principal is Application,
  action == Action::"connector.admin.list",
  resource is Connector
)
when
{
  (
    (resource has plane && resource.plane == "management") ||
    (resource has planes && resource.planes.contains("management"))
  ) &&
  resource has adminList &&
  resource.adminList.contains(principal)
};

@id("connector-admin-read")
permit (
  principal is Application,
  action == Action::"connector.admin.read",
  resource is Connector
)
when
{
  (
    (resource has plane && resource.plane == "management") ||
    (resource has planes && resource.planes.contains("management"))
  ) &&
  resource has adminRead &&
  resource.adminRead.contains(principal)
};

@id("connector-admin-write")
permit (
  principal is Application,
  action == Action::"connector.admin.write",
  resource is Connector
)
when
{
  (
    (resource has plane && resource.plane == "management") ||
    (resource has planes && resource.planes.contains("management"))
  ) &&
  resource has adminWrite &&
  resource.adminWrite.contains(principal)
};
