import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.ts";

const env = {
  GATEWAY_ALLOWED_ORIGINS: "",
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

test("oauth authorization_code grant requires DPoP proof", async () => {
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
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid_grant",
    error_description: "valid DPoP proof required",
  });
});
