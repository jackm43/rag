import type { ConnectorInvokeJob, ConnectorOperation, ConnectorResult, Env } from "../contracts";

// Caller-side helper for the credential broker. A caller binds the CONNECTORS
// entrypoint and calls this with its own principal name (`caller`). Trust is
// structural — only a worker whose wrangler declares the binding can reach the
// broker — so the call is a plain RPC: no envelope, no identity token. Calling
// the broker reads like an ordinary method call.

const build = async (
  env: Env,
  caller: string,
  job: Omit<ConnectorInvokeJob, "kind" | "scopes"> & { scopes?: string[] },
): Promise<ConnectorResult> => {
  if (!env.CONNECTORS) {
    throw new Error("CONNECTORS service binding is required to call the credential broker");
  }
  return env.CONNECTORS.invoke({ kind: "connector.invoke", scopes: [], ...job }, caller);
};

// The uniform broker surface, pre-bound to an env + the calling principal.
export const connectorsClient = (env: Env, caller: string) => ({
  // Exchange the caller's identity for an opaque handle. `params` carries
  // connector-specific grant inputs (e.g. github_app's installationId).
  grant: (connectorId: string, options: { scopes?: string[]; params?: Record<string, unknown> } = {}) =>
    build(env, caller, {
      operation: "grant",
      connectorId,
      ...(options.scopes ? { scopes: options.scopes } : {}),
      paramsJson: JSON.stringify(options.params ?? {}),
    }),
  // Use a handle to have the broker make the call; the credential stays broker-side.
  authorizedFetch: (
    handle: string,
    request: { method: string; path: string; headers?: Record<string, string>; body?: string },
  ) =>
    build(env, caller, {
      operation: "fetch",
      handle,
      paramsJson: JSON.stringify({ request }),
    }),
  // Extract a real short-lived token (the must-call-directly escape hatch).
  getAccessToken: (handle: string) =>
    build(env, caller, { operation: "token", handle, paramsJson: "" }),
  introspect: (handle: string) =>
    build(env, caller, { operation: "introspect", handle, paramsJson: "" }),
  beginAuthorization: (connectorId: string, params: Record<string, unknown>, scopes?: string[]) =>
    build(env, caller, {
      operation: "begin_authorization" as ConnectorOperation,
      connectorId,
      ...(scopes ? { scopes } : {}),
      paramsJson: JSON.stringify(params),
    }),
  completeAuthorization: (connectorId: string, params: Record<string, unknown>) =>
    build(env, caller, {
      operation: "complete_authorization" as ConnectorOperation,
      connectorId,
      paramsJson: JSON.stringify(params),
    }),
  // Verify an inbound webhook's signature (the webhooks edge worker). The raw
  // body travels base64 because signatures cover exact bytes; the broker
  // resolves the connector's webhook secret, computes the provider's scheme,
  // and returns only { valid, eventId? } — the receiver never sees the secret.
  verifyWebhook: (
    connectorId: string,
    webhook: { provider: string; signatureHeaders: Record<string, string>; bodyBase64: string },
  ) =>
    build(env, caller, {
      operation: "webhook_verify" as ConnectorOperation,
      connectorId,
      paramsJson: JSON.stringify(webhook),
    }),

  // Management (admin) surface. These NEVER touch a grant/handle and NEVER
  // return a secret value; each is separately Cedar-gated (connector.admin.*) at
  // the broker. Used by the admin app (the dev-proxy), not the credential caller.
  listConnectors: () =>
    build(env, caller, { operation: "admin_list" as ConnectorOperation, paramsJson: "" }),
  describeConnector: (connectorId: string) =>
    build(env, caller, {
      operation: "admin_describe" as ConnectorOperation,
      connectorId,
      paramsJson: "",
    }),
  // The secret value flows inward only (into paramsJson -> the broker -> the
  // backend); it is never returned. `ref` is the backend locator.
  setConnectorSecret: (
    connectorId: string,
    secret: { provider: string; ref?: string; value?: string },
  ) =>
    build(env, caller, {
      operation: "admin_set_secret" as ConnectorOperation,
      connectorId,
      paramsJson: JSON.stringify(secret),
    }),
  getSecretsProviders: () =>
    build(env, caller, { operation: "admin_providers" as ConnectorOperation, paramsJson: "" }),
  // A github_app connector's App installations (id + account + repository
  // selection), for the admin UI's installation picker. The App JWT that lists
  // them stays broker-side.
  listInstallations: (connectorId: string) =>
    build(env, caller, {
      operation: "admin_installations" as ConnectorOperation,
      connectorId,
      paramsJson: "",
    }),
});
