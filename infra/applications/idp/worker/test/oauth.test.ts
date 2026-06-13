import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.ts";

const env = {
  GATEWAY_ALLOWED_ORIGINS: "",
  GATEWAY_ISSUER: "https://auth.example",
  ACCESS_TEAM_DOMAIN: "team.example",
  ACCESS_OIDC_CLIENT_ID: "client",
} as unknown as Parameters<typeof worker.fetch>[1];

const ctx = {
  waitUntil() {},
} as unknown as ExecutionContext;

test("oauth token endpoint requires form-encoded requests", async () => {
  const response = await worker.fetch(
    new Request("https://auth.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid_request",
    error_description: "token requests must use application/x-www-form-urlencoded",
  });
});

test("oauth authorization_code grant answers a DPoP challenge when the proof is missing", async () => {
  const response = await worker.fetch(
    new Request("https://auth.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "code",
        code_verifier: "verifier",
        redirect_uri: "https://app.example/callback",
      }),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /^DPoP /);
  assert.deepEqual(await response.json(), {
    error: "invalid_dpop_proof",
    error_description: "a valid DPoP proof is required for this grant",
  });
});

test("oauth revoke returns an empty 200 for any token without leaking validity", async () => {
  const response = await worker.fetch(
    new Request("https://auth.example/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "rst_not-a-real-token", token_type_hint: "refresh_token" }),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
});

test("oauth revoke still requires a token parameter", async () => {
  const response = await worker.fetch(
    new Request("https://auth.example/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid_request",
    error_description: "token is required",
  });
});

test("oauth introspect rejects an unauthorized caller with a 401 challenge", async () => {
  const response = await worker.fetch(
    new Request("https://auth.example/oauth/introspect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "anything" }),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
  assert.deepEqual(await response.json(), {
    error: "invalid_token",
    error_description: "introspection requires an authorized caller",
  });
});
