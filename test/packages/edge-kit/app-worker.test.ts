import { assert, test } from "vitest";

import {
  createAppWorker,
  webhookClient,
  type AuthGatewayBinding,
  type AuthorizeInput,
  type AuthRequest,
  type Principal,
} from "@rag/edge-kit";

// A stub AUTH binding whose behaviour each test controls, so the middleware is
// exercised end to end without a real auth worker.
const stubAuth = (overrides: Partial<AuthGatewayBinding> = {}): AuthGatewayBinding => ({
  authenticateClient: async (request: AuthRequest) =>
    request.headers["authorization"] === "Bearer good"
      ? { ok: true, principal: { subject: "op", kind: "native", roles: ["operator"] } }
      : { ok: false, status: 401, reason: "bad_token" },
  verify: async () => ({ ok: true }),
  authorize: async (_input: AuthorizeInput) => ({ ok: true }),
  ...overrides,
});

type Env = { AUTH: AuthGatewayBinding };

const worker = (env: Env, extra: Partial<Parameters<typeof createAppWorker<Env>>[0]> = {}) =>
  createAppWorker<Env>({
    service: "demo",
    openapi: { openapi: "3.1.0", info: { title: "demo", version: "0" }, paths: {} },
    discovery: { "demo-config": { issuer: "demo" } },
    routes: [
      {
        method: "GET",
        path: "/api/things/{id}",
        operationId: "getThing",
        action: "thing.read",
        clientKind: "native",
        handler: ({ params, principal }) =>
          Response.json({ id: params.id, subject: principal.subject }),
      },
    ],
    ...extra,
  });

const call = (env: Env, path: string, init?: RequestInit) =>
  worker(env).fetch(new Request(`https://demo.test${path}`, init), env, {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext);

test("health, openapi and well-known discovery are public (no auth)", async () => {
  const env = { AUTH: stubAuth() };
  assert.equal((await call(env, "/health")).status, 200);
  assert.equal((await call(env, "/openapi.json")).status, 200);
  assert.equal((await call(env, "/.well-known/demo-config")).status, 200);
  assert.equal((await call(env, "/.well-known/missing")).status, 404);
});

test("unknown path 404s and wrong method 405s with Allow", async () => {
  const env = { AUTH: stubAuth() };
  assert.equal((await call(env, "/nope")).status, 404);
  const res = await call(env, "/api/things/1", { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET");
});

test("authenticated route: authn denial short-circuits before the handler", async () => {
  const env = { AUTH: stubAuth() };
  const res = await call(env, "/api/things/42");
  assert.equal(res.status, 401);
});

test("authenticated route: authenticate -> verify -> authorize -> handler", async () => {
  const env = { AUTH: stubAuth() };
  const res = await call(env, "/api/things/42", { headers: { authorization: "Bearer good" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "42", subject: "op" });
});

test("authorize denial returns the policy status and skips the handler", async () => {
  const env = { AUTH: stubAuth({ authorize: async () => ({ ok: false, status: 403, reason: "no_policy" }) }) };
  const res = await call(env, "/api/things/42", { headers: { authorization: "Bearer good" } });
  assert.equal(res.status, 403);
});

test("verify denial returns 401 and skips authorize + handler", async () => {
  let authorized = false;
  const env = {
    AUTH: stubAuth({
      verify: async () => ({ ok: false, reason: "revoked" }),
      authorize: async () => {
        authorized = true;
        return { ok: true };
      },
    }),
  };
  const res = await call(env, "/api/things/42", { headers: { authorization: "Bearer good" } });
  assert.equal(res.status, 401);
  assert.equal(authorized, false);
});

test("webhook client verifies locally without delegating authentication", async () => {
  const env = { AUTH: stubAuth({ authenticateClient: async () => ({ ok: false, status: 401, reason: "should_not_be_called" }) }) };
  const verified: Principal = { subject: "evt-1", kind: "webhook" };
  const app = createAppWorker<Env>({
    service: "hooks",
    routes: [
      {
        method: "POST",
        path: "/ingest",
        operationId: "ingest",
        action: "webhook.ingest",
        clientKind: "webhook",
        handler: ({ principal }) => Response.json({ subject: principal.subject }),
      },
    ],
    clients: {
      webhook: webhookClient<Env>(async (request) =>
        request.headers.get("x-sig") === "ok" ? verified : null,
      ),
    },
  });
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  const denied = await app.fetch(new Request("https://hooks.test/ingest", { method: "POST" }), env, ctx);
  assert.equal(denied.status, 401);

  const ok = await app.fetch(
    new Request("https://hooks.test/ingest", { method: "POST", headers: { "x-sig": "ok" } }),
    env,
    ctx,
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { subject: "evt-1" });
});
