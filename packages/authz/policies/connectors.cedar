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
