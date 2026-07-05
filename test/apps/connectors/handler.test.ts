import { assert, test } from "vitest";

import { handleConnectorInvoke } from "@rag/connectors-core/lib/handler";
import { createInMemoryKeyValueStore, generateHandle } from "@rag/connectors-core/lib/store";
import type { GrantEntry } from "@rag/connectors-core/lib/types";
import type { ConnectorInvokeJob } from "@rag/connectors-core/contracts";

// The broker is reached only over the trusted CONNECTORS binding, so the caller
// arrives as a plain string alongside the job — no signature. The security
// invariants that remain: EVERY operation is authorized (a per-connector
// capabilities check) before any credential is touched, and a handle is bound to
// the caller it was issued to. These tests prove each gate fails closed.

const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAo6ZO6+S+oJqKOgltJGvUQ7e0QNH3eMLKXEx4+/a9xFEg/b9w
z8gjyNxqBS4Qzt3T4l2bd+sMkslE2rSBxpePANtrHGrzWK5JvsoCkgDF58xpZ1rt
Pmm6NgteGCnAhTwbZksnTJaaPH0sijdQWQIlx6ctJ9bbdwU7vZfgVSO7cV5QO5dW
ZQpcF/VE2Sr2DFI6uiixUD8ZY478Jve0I1q6YuDfzWzwHjqxpaQslecz4UgvdSQk
9nInClmrjBq2E8ycyRNxwWqGoV8238VygLyDEo5uBiU3Qe0uqnHj2NZoJsqWjsKs
v5qjSzWMIRZNvd1NmWT7W2paW92WchtPZLFBBQIDAQABAoIBAAY1pYl8ZsJT0tpk
aKyI3edK5W9POEdwBrstWKrg4C7+kBSoyrhLpRX2TRyQtKkQ0D0m5aMNe27nbbIp
xsHZFt9GtCACK+UpydkQM7xEBL5oqng2QknLu7nYwROEJA66KuT9BYr5rPUOH95H
vof+FZ5niMZZ9/5iZ7OoO2YnorFovfFqaZX2nLketNTSZyOBqUewKxn9/0dnKzRv
F4wERl9MiLaYLZsn77l8vMnpZ4kZxyyDDN/UsTm99mxjT7FQPVoY7H5+msLpupCt
nTeoqNivZ7fp2I9xFABQ2kfN3hKjXJfo7yGSpQhXK1B/TNAo7j+S9iQYPvgLAlTf
UDAq5ykCgYEA1ReQw/oPolumsU/c9AUEkYHRGU477mj3zfE8y7Vcgh3pS/vpzc6g
pq7i0hwikTGBlVO8NYcDwferWfr6xC92ORcu+IPLXfE0t0/Kjl6zgp1LKbUJJoiW
vJcaEdj0e1JbljQQff/gLBSixfv78TvRCklpoCII3TvnG4CoCuGyQF0CgYEAxJoX
6wqGU4nElS45p4x1V8EPKt510kaYdMtUvIMdgD8b3U7v2YUNRultgGVQQsrRddaK
nSsRiDW9gwWb/G5X0EsmbTRYsSqe7plNzIEraStzWjYhmfJUXei9FUi6H6IF0ZAy
/TSlbZ1yWx2nQw8O7FlASDL77SbCbazmOdVEGMkCgYBK5qmf+TmdnBGPqb7Ely7v
5m2VM4alWogf/3ebMvh9U/45EycvjD2z2S0pJXKRDpG552D0f6y2dVPpoOqcIwKv
NpLwD4NgVfRtqsJMIMWAV8Gfu16oCMLTL1mehGALKPvAZDSX1WT6mZZNeTEprhjg
QMW737q16ORnKmXmzUZWkQKBgQCmjJ/chsL6vAgkFM/Ux6GUoMFXoLORWirHLoVv
WWfBgDT7y2ZXEGcJ/q+8CJfwrV66g/BTauvkRxpvh234cAXGOBOqiaDlHWUcXhTR
PU/oPV3wO1FF2Etubr7X7A94wspJGO6JIHNQJAR/eeR7Y6NRx940C7Tt11r4jHNQ
5QFWOQKBgFbkIEdPI1Xnq9eb7dsd3yn9l2+xM752rSjU/djLNBOkOVIEZjQXLRkA
5RMk+V3+h5ZLvr3kgsWmbXC8DEB5JNTkN37N6D4KF/acIKOfUtbINoK1zgyNF1w6
qhhkkLkLAwdN0kPoYSUiv+KB3SK9k3ggNbXrb6ohM3oyyZC6r9hH
-----END RSA PRIVATE KEY-----`;

const captureLogs = () => {
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const lines: Array<Record<string, unknown>> = [];
  const push = (line: unknown) => lines.push(JSON.parse(String(line)));
  console.warn = push;
  console.info = push;
  return {
    lines,
    restore: () => {
      console.warn = originalWarn;
      console.info = originalInfo;
    },
  };
};

const captureFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
};

const storeEnv = (overrides: Record<string, unknown> = {}) => {
  const kv = createInMemoryKeyValueStore();
  const stub = { read: kv.read, write: kv.write, remove: kv.remove };
  return {
    kv,
    env: {
      CONNECTOR_STORE: { idFromName: () => "id", get: () => stub },
      ...overrides,
    } as never,
  };
};

const grantJob = (connectorId: string, params: Record<string, unknown> = {}): ConnectorInvokeJob => ({
  kind: "connector.invoke",
  operation: "grant",
  connectorId,
  scopes: [],
  paramsJson: JSON.stringify(params),
});

const adminJob = (
  operation: ConnectorInvokeJob["operation"],
  extra: Partial<ConnectorInvokeJob> = {},
): ConnectorInvokeJob => ({
  kind: "connector.invoke",
  operation,
  scopes: [],
  paramsJson: "",
  ...extra,
});

test("admin_list: the dev-proxy admin caller lists connectors and their status, never secrets", async () => {
  const logs = captureLogs();
  try {
    const { env } = storeEnv();
    const result = await handleConnectorInvoke(adminJob("admin_list"), "dev-proxy", env);
    assert.equal(result.status, 200);
    const github = (result.connectors ?? []).find((c) => c.id === "github-app");
    assert.ok(github);
    assert.equal(github.secretProvider, "wrangler-env");
    assert.equal(github.secretConfigured, false);
    assert.include(github.flows, "fetch");
    assert.ok(logs.lines.some((line) => line.message === "connector_admin" && line.operation === "admin_list"));
  } finally {
    logs.restore();
  }
});

test("admin ops fail closed: the workflows worker (a credential caller, not an admin) is denied", async () => {
  const logs = captureLogs();
  try {
    const { env } = storeEnv();
    const result = await handleConnectorInvoke(adminJob("admin_list"), "workflows", env);
    assert.equal(result.status, 403);
  } finally {
    logs.restore();
  }
});

test("admin_providers: reports each backend's runtime write capability (no values)", async () => {
  const { env } = storeEnv({ VAULT_ADDR: "https://vault.example.com", VAULT_TOKEN: "s.token" });
  const result = await handleConnectorInvoke(adminJob("admin_providers"), "dev-proxy", env);
  assert.equal(result.status, 200);
  const byName = Object.fromEntries((result.providers ?? []).map((p) => [p.name, p]));
  assert.equal(byName["wrangler-env"].writable, false);
  assert.equal(byName["cloudflare-secret-store"].writable, false);
  assert.equal(byName["hashicorp-vault"].writable, true);
  assert.equal(byName["hashicorp-vault"].configured, true);
  assert.equal(byName["onepassword"].writable, true);
});

test("set-secret: wrangler-env with a value is rejected (deploy-time only), nothing persisted", async () => {
  const { env } = storeEnv();
  const result = await handleConnectorInvoke(
    adminJob("admin_set_secret", {
      connectorId: "github-app",
      paramsJson: JSON.stringify({ provider: "wrangler-env", ref: "GITHUB_APP_PRIVATE_KEY", value: "super-secret-pem" }),
    }),
    "dev-proxy",
    env,
  );
  assert.equal(result.status, 200);
  assert.equal(result.secret?.status, "rejected");
  assert.notInclude(JSON.stringify(result), "super-secret-pem");

  const described = await handleConnectorInvoke(adminJob("admin_describe", { connectorId: "github-app" }), "dev-proxy", env);
  assert.equal(described.connector?.secretOverridden, false);
});

test("set-secret: cloudflare-secret-store with a value re-points but requires out-of-band provisioning", async () => {
  const { env } = storeEnv();
  const result = await handleConnectorInvoke(
    adminJob("admin_set_secret", {
      connectorId: "github-app",
      paramsJson: JSON.stringify({ provider: "cloudflare-secret-store", ref: "GH_APP_KEY", value: "x" }),
    }),
    "dev-proxy",
    env,
  );
  assert.equal(result.status, 200);
  assert.equal(result.secret?.status, "provision_required");
  assert.include(result.secret?.detail ?? "", "GH_APP_KEY");
});

test("set-secret: hashicorp-vault writes the value at runtime and the connector re-points to it", async () => {
  const { env } = storeEnv({ VAULT_ADDR: "https://vault.example.com", VAULT_TOKEN: "s.token" });
  const vault = captureFetch((_url, init) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({}), { status: 200 })
      : new Response(JSON.stringify({ data: { data: { GITHUB_APP_PRIVATE_KEY: "vault-stored-pem" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
  );
  try {
    const result = await handleConnectorInvoke(
      adminJob("admin_set_secret", {
        connectorId: "github-app",
        paramsJson: JSON.stringify({
          provider: "hashicorp-vault",
          ref: "secret/ragbot#GITHUB_APP_PRIVATE_KEY",
          value: "vault-stored-pem",
        }),
      }),
      "dev-proxy",
      env,
    );
    assert.equal(result.status, 200);
    assert.equal(result.secret?.status, "written");
    assert.equal(result.secret?.secretConfigured, true);
    assert.notInclude(JSON.stringify(result), "vault-stored-pem");

    const described = await handleConnectorInvoke(adminJob("admin_describe", { connectorId: "github-app" }), "dev-proxy", env);
    assert.equal(described.connector?.secretProvider, "hashicorp-vault");
    assert.equal(described.connector?.secretOverridden, true);
  } finally {
    vault.restore();
  }
});

test("denies a caller without the connector capability", async () => {
  const logs = captureLogs();
  try {
    // spend holds no capability on github-app, so a grant is refused.
    const result = await handleConnectorInvoke(grantJob("github-app"), "spend", storeEnv().env);
    assert.equal(result.status, 403);
    assert.ok(logs.lines.some((line) => line.reason === "not_authorized"));
  } finally {
    logs.restore();
  }
});

test("denies an operation the caller is not authorized for", async () => {
  const logs = captureLogs();
  try {
    // workflows may grant/fetch/token github-app, but is NOT granted authorize.
    const { env } = storeEnv();
    const result = await handleConnectorInvoke(
      { kind: "connector.invoke", operation: "begin_authorization", connectorId: "github-app", scopes: [], paramsJson: "{}" },
      "workflows",
      env,
    );
    assert.equal(result.status, 403);
    assert.ok(logs.lines.some((line) => line.message === "connector_denied" && line.reason === "not_authorized"));
  } finally {
    logs.restore();
  }
});

test("admin_set_capabilities replaces connector authorization from the DO config store", async () => {
  const { env } = storeEnv({ GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY });
  const revoke = await handleConnectorInvoke(
    adminJob("admin_set_capabilities", {
      connectorId: "github-app",
      paramsJson: JSON.stringify({
        capabilities: { grant: ["dev-proxy"], fetch: ["dev-proxy"], adminRead: ["dev-proxy"], adminWrite: ["dev-proxy"] },
      }),
    }),
    "dev-proxy",
    env,
  );
  assert.equal(revoke.status, 200);

  const workflowsGrant = await handleConnectorInvoke(grantJob("github-app", { installationId: "12345" }), "workflows", env);
  assert.equal(workflowsGrant.status, 403);

  const describe = await handleConnectorInvoke(adminJob("admin_describe", { connectorId: "github-app" }), "dev-proxy", env);
  assert.equal(describe.status, 200);
});

test("denies a grant for an unknown connector", async () => {
  const { env } = storeEnv();
  const result = await handleConnectorInvoke(grantJob("does-not-exist"), "workflows", env);
  assert.equal(result.status, 404);
});

test("rejects a handle presented by a service other than the one it was issued to", async () => {
  const logs = captureLogs();
  const { kv, env } = storeEnv();
  try {
    const handle = generateHandle();
    const entry: GrantEntry = {
      handle,
      connectorId: "github-app",
      callerPrincipal: "gateway",
      subject: "user-1",
      scopes: [],
      params: { installationId: "12345" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    await kv.write(`grant:${handle}`, JSON.stringify(entry));

    const result = await handleConnectorInvoke(
      { kind: "connector.invoke", operation: "fetch", handle, scopes: [], paramsJson: JSON.stringify({ request: { method: "GET", path: "/repos/o/r" } }) },
      "workflows",
      env,
    );
    assert.equal(result.status, 404);
    assert.ok(logs.lines.some((line) => line.reason === "handle_caller_mismatch"));
  } finally {
    logs.restore();
  }
});

test("fails closed at grant when the connector's secret does not resolve", async () => {
  const logs = captureLogs();
  const { env } = storeEnv({ GITHUB_APP_ID: "123456" });
  try {
    const result = await handleConnectorInvoke(grantJob("github-app", { installationId: "12345" }), "workflows", env);
    assert.equal(result.status, 500);
    assert.ok(
      logs.lines.some((line) => line.message === "connector_denied" && String(line.reason).startsWith("secret_unresolved")),
    );
  } finally {
    logs.restore();
  }
});

test("grant then authorizedFetch: the credential is injected server-side and never returned", async () => {
  const logs = captureLogs();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const fetchMock = captureFetch((url) =>
    url.endsWith("/access_tokens")
      ? new Response(JSON.stringify({ token: "ghs_installation", expires_at: expiresAt }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ full_name: "o/r" }), {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "leak=1" },
        }),
  );
  const { env } = storeEnv({ GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY });
  try {
    const granted = await handleConnectorInvoke(grantJob("github-app", { installationId: "12345" }), "workflows", env);
    assert.equal(granted.status, 200);
    const handle = granted.grant?.handle;
    assert.isString(handle);
    assert.notInclude(JSON.stringify(granted), "ghs_installation");

    const fetched = await handleConnectorInvoke(
      { kind: "connector.invoke", operation: "fetch", handle, scopes: [], paramsJson: JSON.stringify({ request: { method: "GET", path: "/repos/o/r" } }) },
      "workflows",
      env,
    );
    assert.equal(fetched.status, 200);
    assert.equal(fetched.fetch?.status, 200);
    assert.include(fetched.fetch?.body ?? "", "o/r");

    const apiCall = fetchMock.calls.find((call) => call.url.endsWith("/repos/o/r"));
    assert.ok(apiCall);
    const headers = new Headers(apiCall.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer ghs_installation");
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.isUndefined(fetched.fetch?.headers["set-cookie"]);

    const audit = logs.lines.find((line) => line.message === "connector_use");
    assert.ok(audit);
    assert.equal(audit.callerPrincipal, "workflows");
    assert.equal(audit.grantId, handle);
  } finally {
    logs.restore();
    fetchMock.restore();
  }
});
