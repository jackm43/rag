import type { ServiceClient, Subject } from "../auth";
import { encodeConnectorInvokeEnvelope } from "../contracts";
import type {
  ConnectorInvokeJob,
  ConnectorOperation,
  ConnectorResult,
  Env,
} from "../contracts/types";

// Caller-side helper for the credential broker. A future caller (e.g. the brain)
// binds the CONNECTORS entrypoint and holds a ServiceClient for the
// self -> connectors hop (serviceClients(env).brainToConnectors). This wraps the
// two moving parts every call needs — framing the connector.invoke envelope and
// minting the envelope-bound identity token via the client — so calling the
// broker reads like an ordinary method call.
//
// No worker uses this yet in this task; it exists so wiring a caller later is a
// binding + these calls, not a re-implementation of the hop.

const build = async (
  env: Env,
  client: ServiceClient,
  subject: Subject,
  job: Omit<ConnectorInvokeJob, "kind" | "scopes"> & { scopes?: string[] },
): Promise<ConnectorResult> => {
  if (!env.CONNECTORS) {
    throw new Error("CONNECTORS service binding is required to call the credential broker");
  }
  const envelope = encodeConnectorInvokeEnvelope(
    { kind: "connector.invoke", scopes: [], ...job },
    { source: "worker" },
  );
  const message = await client.prepare(envelope, subject);
  return env.CONNECTORS.invoke(message);
};

// The uniform broker surface, pre-bound to an env + hop client + acting subject.
export const connectorsClient = (env: Env, client: ServiceClient, subject: Subject) => ({
  // Exchange the caller's identity for an opaque handle. `params` carries
  // connector-specific grant inputs (e.g. github_app's installationId).
  grant: (connectorId: string, options: { scopes?: string[]; params?: Record<string, unknown> } = {}) =>
    build(env, client, subject, {
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
    build(env, client, subject, {
      operation: "fetch",
      handle,
      paramsJson: JSON.stringify({ request }),
    }),
  // Extract a real short-lived token (the must-call-directly escape hatch).
  getAccessToken: (handle: string) =>
    build(env, client, subject, { operation: "token", handle, paramsJson: "" }),
  introspect: (handle: string) =>
    build(env, client, subject, { operation: "introspect", handle, paramsJson: "" }),
  beginAuthorization: (connectorId: string, params: Record<string, unknown>, scopes?: string[]) =>
    build(env, client, subject, {
      operation: "begin_authorization" as ConnectorOperation,
      connectorId,
      ...(scopes ? { scopes } : {}),
      paramsJson: JSON.stringify(params),
    }),
  completeAuthorization: (connectorId: string, params: Record<string, unknown>) =>
    build(env, client, subject, {
      operation: "complete_authorization" as ConnectorOperation,
      connectorId,
      paramsJson: JSON.stringify(params),
    }),

  // Management (admin) surface. These NEVER touch a grant/handle and NEVER
  // return a secret value; each is separately Cedar-gated (connector.admin.*) at
  // the broker. Used by the admin app (the dev-proxy), not the credential caller.
  listConnectors: () =>
    build(env, client, subject, { operation: "admin_list" as ConnectorOperation, paramsJson: "" }),
  describeConnector: (connectorId: string) =>
    build(env, client, subject, {
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
    build(env, client, subject, {
      operation: "admin_set_secret" as ConnectorOperation,
      connectorId,
      paramsJson: JSON.stringify(secret),
    }),
  getSecretsProviders: () =>
    build(env, client, subject, { operation: "admin_providers" as ConnectorOperation, paramsJson: "" }),
});
