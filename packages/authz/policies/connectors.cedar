// Credential-broker authorization: which service may use which connector, and
// for which operation. This is the per-connector capability gate the broker runs
// AFTER the identity token is verified and AFTER service.invoke authorizes the
// hop — the second of the broker's two Cedar checks (services.cedar authorizes
// reaching the broker at all; these policies authorize touching a credential).
//
// Actions, one per credential-facing operation against `Connector::<id>`:
//   - connector.grant     — obtain an opaque handle (the token exchange).
//   - connector.fetch      — use a handle to have the broker make the call, and
//                            to introspect one's own handle.
//   - connector.token      — extract a real short-lived token (the sensitive
//                            must-call-directly escape hatch).
//   - connector.authorize  — begin/complete a 3LO authorization.
//
// These grants are DELIBERATELY EXPLICIT, not derived from the registry: a
// manifest change can never silently widen who can reach a credential. Adding a
// grant is a permit here (fail closed — no permit, no access). The service-hop
// layer (services.cedar) is what is registry-driven.

// The reference connector: the brain may use the GitHub App connector. It may
// obtain a handle, fetch through it, and extract an installation token; it is not
// granted connector.authorize (the GitHub App is 2LO — it has no 3LO flow).
@id("brain-github-app-grant")
permit (
  principal == Machine::"brain",
  action == Action::"connector.grant",
  resource == Connector::"github-app"
);

@id("brain-github-app-fetch")
permit (
  principal == Machine::"brain",
  action == Action::"connector.fetch",
  resource == Connector::"github-app"
);

@id("brain-github-app-token")
permit (
  principal == Machine::"brain",
  action == Action::"connector.token",
  resource == Connector::"github-app"
);

// The connectors ADMIN surface: management operations, distinct from the
// credential-facing connector.grant/fetch/token above. The dev-proxy (the admin
// application, authenticated by CF Access + a Better Auth Discord session and
// carrying its verified machine identity token into the broker) is the only
// admin caller. These actions NEVER return a secret value.
//
//   - connector.admin.list  — list connectors / list secrets backends (broker-
//                             wide, against the Connector::"*" sentinel).
//   - connector.admin.read  — describe one connector's config + status.
//   - connector.admin.write — write / re-point one connector's secret.
//
// The dev-proxy holds NO connector.grant/fetch/token permit, so the admin caller
// can manage connectors but can never use a credential. Broker-wide list/
// providers are permitted only against the "*" sentinel (which CONNECTOR_ID_PATTERN
// forbids as a real id), so this does not widen per-connector access.
@id("devproxy-connector-admin-broker")
permit (
  principal == Machine::"dev-proxy",
  action == Action::"connector.admin.list",
  resource == Connector::"*"
);

@id("devproxy-connector-admin-manage")
permit (
  principal == Machine::"dev-proxy",
  action in [Action::"connector.admin.read", Action::"connector.admin.write"],
  resource is Connector
);
