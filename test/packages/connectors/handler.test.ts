import { assert, test } from "vitest";

import { handleConnectorInvoke } from "../../../packages/connectors/handler.ts";
import { createInMemoryKeyValueStore, generateHandle } from "../../../packages/connectors/store.ts";
import type { GrantEntry } from "../../../packages/connectors/types.ts";
import { encodeConnectorInvokeEnvelope, encodeServiceMessage } from "../../../packages/contracts/index.ts";
import type { ConnectorInvokeJob } from "../../../packages/contracts/types.ts";
import { mintServiceToken, signedServiceMessage } from "../../helpers.ts";

// The security invariant: EVERY operation is authenticated (identity-context
// token verified via the shared createServiceServer pipeline) AND authorized
// (Cedar) before any credential is touched, and a handle is bound to the caller
// it was issued to. These tests prove each gate fails closed — the only way to
// prove fail-closed is to try to get through.

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

// A CONNECTOR_STORE binding backed by an in-memory kv, plus direct kv access for
// pre-seeding grants in the caller-binding test.
const storeEnv = (overrides: Record<string, unknown> = {}) => {
  const kv = createInMemoryKeyValueStore();
  const stub = { read: kv.read, write: kv.write, remove: kv.remove };
  return {
    kv,
    env: { CONNECTOR_STORE: { idFromName: () => "id", get: () => stub }, ...overrides } as never,
  };
};

const encode = (job: ConnectorInvokeJob) => encodeConnectorInvokeEnvelope(job, { source: "worker" });

const grantJob = (connectorId: string, params: Record<string, unknown> = {}): ConnectorInvokeJob => ({
  kind: "connector.invoke",
  operation: "grant",
  connectorId,
  scopes: [],
  paramsJson: JSON.stringify(params),
});

test("denies an unauthenticated call — a token not addressed to the broker", async () => {
  const logs = captureLogs();
  try {
    // A cryptographically valid brain token, but minted for the spend service:
    // the broker's verifier rejects the audience before anything else runs.
    const message = await signedServiceMessage(encode(grantJob("github-app")), {
      iss: "brain",
      aud: "spend",
    });
    const result = await handleConnectorInvoke(message, storeEnv().env);
    assert.equal(result.status, 401);
    assert.ok(logs.lines.some((line) => line.reason === "identity_aud_mismatch"));
  } finally {
    logs.restore();
  }
});

test("denies a forged token (signature does not verify)", async () => {
  const logs = captureLogs();
  try {
    const envelope = encode(grantJob("github-app"));
    const token = await mintServiceToken(envelope, { iss: "brain", aud: "connectors" });
    // Tamper the signature segment.
    const forged = encodeServiceMessage(envelope, `${token.slice(0, -4)}AAAA`);
    const result = await handleConnectorInvoke(forged, storeEnv().env);
    assert.equal(result.status, 401);
  } finally {
    logs.restore();
  }
});

test("denies an operation the caller is not authorized for (Cedar)", async () => {
  const logs = captureLogs();
  try {
    // The brain may grant/fetch/token the GitHub App connector, but is NOT granted
    // connector.authorize — a begin_authorization is refused by Cedar before any
    // strategy or credential runs.
    const message = await signedServiceMessage(
      encode({
        kind: "connector.invoke",
        operation: "begin_authorization",
        connectorId: "github-app",
        scopes: [],
        paramsJson: "{}",
      }),
      { iss: "brain", aud: "connectors" },
    );
    const result = await handleConnectorInvoke(message, storeEnv().env);
    assert.equal(result.status, 403);
    assert.ok(
      logs.lines.some(
        (line) => line.message === "connector_denied" && line.reason === "not_authorized",
      ),
    );
  } finally {
    logs.restore();
  }
});

test("denies a grant for an unknown connector", async () => {
  const message = await signedServiceMessage(encode(grantJob("does-not-exist")), {
    iss: "brain",
    aud: "connectors",
  });
  const result = await handleConnectorInvoke(message, storeEnv().env);
  assert.equal(result.status, 404);
});

test("rejects a handle presented by a service other than the one it was issued to", async () => {
  const logs = captureLogs();
  const { kv, env } = storeEnv();
  try {
    // A grant issued to the gateway, pre-seeded into the store.
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

    // The brain (a different, validly authenticated caller) presents it.
    const message = await signedServiceMessage(
      encode({
        kind: "connector.invoke",
        operation: "fetch",
        handle,
        scopes: [],
        paramsJson: JSON.stringify({ request: { method: "GET", path: "/repos/o/r" } }),
      }),
      { iss: "brain", aud: "connectors" },
    );
    const result = await handleConnectorInvoke(message, env);
    assert.equal(result.status, 404);
    assert.ok(logs.lines.some((line) => line.reason === "handle_caller_mismatch"));
  } finally {
    logs.restore();
  }
});

test("grant then authorizedFetch: the credential is injected server-side and never returned", async () => {
  const logs = captureLogs();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const fetchMock = captureFetch((url) => {
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_installation", expires_at: expiresAt }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ full_name: "o/r" }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "leak=1" },
    });
  });
  const { env } = storeEnv({ GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY });
  try {
    const grantMessage = await signedServiceMessage(encode(grantJob("github-app", { installationId: "12345" })), {
      iss: "brain",
      aud: "connectors",
    });
    const granted = await handleConnectorInvoke(grantMessage, env);
    assert.equal(granted.status, 200);
    const handle = granted.grant?.handle;
    assert.isString(handle);
    // The grant response carries only the opaque handle, never a credential.
    assert.notInclude(JSON.stringify(granted), "ghs_installation");

    const fetchMessage = await signedServiceMessage(
      encode({
        kind: "connector.invoke",
        operation: "fetch",
        handle,
        scopes: [],
        paramsJson: JSON.stringify({ request: { method: "GET", path: "/repos/o/r" } }),
      }),
      { iss: "brain", aud: "connectors" },
    );
    const fetched = await handleConnectorInvoke(fetchMessage, env);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.fetch?.status, 200);
    assert.include(fetched.fetch?.body ?? "", "o/r");

    // The installation token was injected as Authorization on the API call...
    const apiCall = fetchMock.calls.find((call) => call.url.endsWith("/repos/o/r"));
    assert.ok(apiCall);
    const headers = new Headers(apiCall.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer ghs_installation");
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    // ...and the response was header-filtered (no Set-Cookie leaks to the caller).
    assert.isUndefined(fetched.fetch?.headers["set-cookie"]);

    // Every use is audited with the full actor chain.
    const audit = logs.lines.find((line) => line.message === "connector_use");
    assert.ok(audit);
    assert.equal(audit.connectorId, "github-app");
    assert.equal(audit.callerPrincipal, "brain");
    assert.equal(audit.grantId, handle);
  } finally {
    logs.restore();
    fetchMock.restore();
  }
});
