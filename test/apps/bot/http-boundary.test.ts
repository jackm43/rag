import { assert, test } from "vitest";
import nacl from "tweetnacl";

import worker from "@rag/gateway/src";
import { bearerTokenMatches, secretsMatch } from "@rag/ingress/operator-control";
import { createEnv, createSignedRequest } from "../../helpers";

test("secretsMatch compares bearer tokens without string equality", () => {
  assert.equal(secretsMatch("Bearer bot-token", "Bearer bot-token"), true);
  assert.equal(secretsMatch("Bearer bot-tokem", "Bearer bot-token"), false);
  assert.equal(secretsMatch("Bearer bot-token-extra", "Bearer bot-token"), false);
});

test("bearerTokenMatches parses authorization before comparing the token", () => {
  assert.equal(bearerTokenMatches("Bearer bot-token", "bot-token"), true);
  assert.equal(bearerTokenMatches("bearer bot-token", "bot-token"), true);
  assert.equal(bearerTokenMatches("Bot bot-token", "bot-token"), false);
  assert.equal(bearerTokenMatches("Bearer bot-tokem", "bot-token"), false);
});

test("GET / returns 404", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = new Request("https://example.com/", { method: "GET" });

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});

test("old root interaction route returns 404", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey, "/");

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});

test("worker rejects /gateway/start without control token auth", async () => {
  let startCalls = 0;
  const env = createEnv("unused", {
    DISCORD_BOT_TOKEN: "bot-token",
    GATEWAY_CONTROL_TOKEN: "control-token",
    DISCORD_GATEWAY: {
      idFromName: () => "id",
      get: () => ({
        start: async () => {
          startCalls += 1;
          return { ok: true };
        },
      }),
    },
  });

  const wrongMethod = await worker.fetch(
    new Request("https://example.com/gateway/start", { method: "GET" }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal(startCalls, 0);

  const unauthorized = await worker.fetch(
    new Request("https://example.com/gateway/start", { method: "POST" }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(startCalls, 0);

  const botToken = await worker.fetch(
    new Request("https://example.com/gateway/start", {
      method: "POST",
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(botToken.status, 401);
  assert.equal(startCalls, 0);

  const authorized = await worker.fetch(
    new Request("https://example.com/gateway/start", {
      method: "POST",
      headers: { authorization: "Bearer control-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { ok: true });
  assert.equal(startCalls, 1);
});

test("worker rejects /gateway/stop without control token auth", async () => {
  let stopCalls = 0;
  const env = createEnv("unused", {
    DISCORD_BOT_TOKEN: "bot-token",
    GATEWAY_CONTROL_TOKEN: "control-token",
    DISCORD_GATEWAY: {
      idFromName: () => "id",
      get: () => ({
        stop: async () => {
          stopCalls += 1;
          return { ok: true };
        },
      }),
    },
  });

  const wrongMethod = await worker.fetch(
    new Request("https://example.com/gateway/stop", { method: "GET" }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal(stopCalls, 0);

  const unauthorized = await worker.fetch(
    new Request("https://example.com/gateway/stop", { method: "POST" }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(stopCalls, 0);

  const botToken = await worker.fetch(
    new Request("https://example.com/gateway/stop", {
      method: "POST",
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(botToken.status, 401);
  assert.equal(stopCalls, 0);

  const authorized = await worker.fetch(
    new Request("https://example.com/gateway/stop", {
      method: "POST",
      headers: { authorization: "Bearer control-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { ok: true });
  assert.equal(stopCalls, 1);
});

test("worker rejects gateway control requests when the control token is not configured", async () => {
  let gatewayCalls = 0;
  const env = createEnv("unused", {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GATEWAY: {
      idFromName: () => "id",
      get: () => ({
        start: async () => {
          gatewayCalls += 1;
          return { ok: true };
        },
        health: async () => {
          gatewayCalls += 1;
          return { connected: false, resumable: false };
        },
      }),
    },
  });

  const start = await worker.fetch(
    new Request("https://example.com/gateway/start", {
      method: "POST",
      headers: { authorization: "Bearer control-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(start.status, 401);

  const health = await worker.fetch(
    new Request("https://example.com/gateway/health", {
      method: "GET",
      headers: { authorization: "Bearer control-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(health.status, 401);
  assert.equal(gatewayCalls, 0);
});

test("worker rejects /gateway/health without control token auth", async () => {
  let healthCalls = 0;
  const env = createEnv("unused", {
    DISCORD_BOT_TOKEN: "bot-token",
    GATEWAY_CONTROL_TOKEN: "control-token",
    DISCORD_GATEWAY: {
      idFromName: () => "id",
      get: () => ({
        health: async () => {
          healthCalls += 1;
          return { connected: false, resumable: false };
        },
      }),
    },
  });

  const wrongMethod = await worker.fetch(
    new Request("https://example.com/gateway/health", {
      method: "POST",
      headers: { authorization: "Bearer control-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  assert.equal(healthCalls, 0);

  const unauthorized = await worker.fetch(
    new Request("https://example.com/gateway/health", { method: "GET" }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(healthCalls, 0);

  const botToken = await worker.fetch(
    new Request("https://example.com/gateway/health", {
      method: "GET",
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(botToken.status, 401);
  assert.equal(healthCalls, 0);

  const authorized = await worker.fetch(
    new Request("https://example.com/gateway/health", {
      method: "GET",
      headers: { authorization: "Bearer control-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { connected: false, resumable: false });
  assert.equal(healthCalls, 1);
});

test("worker fails closed for unconfigured public paths", async () => {
  const keyPair = nacl.sign.keyPair();
  let gatewayFetchCalls = 0;
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GATEWAY: {
      idFromName: () => "id",
      get: () => ({
        start: async () => {
          gatewayFetchCalls += 1;
          return { ok: true };
        },
        health: async () => {
          gatewayFetchCalls += 1;
          return { connected: false, resumable: false };
        },
      }),
    },
  });

  const unknownGet = await worker.fetch(
    new Request("https://example.com/anything", { method: "GET" }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(unknownGet.status, 404);

  const unknownPost = await worker.fetch(
    createSignedRequest({ type: 1 }, keyPair.secretKey, "/anything"),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(unknownPost.status, 404);

  const oauth = await worker.fetch(
    new Request("https://example.com/oauth/config", { method: "GET" }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(oauth.status, 404);

  const admin = await worker.fetch(
    new Request("https://example.com/admin/config", {
      method: "GET",
      headers: { authorization: "Bearer anything" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(admin.status, 404);

  const sourceFilePaths = [
    "/README.md",
    "/AGENTS.md",
    "/src/ai-config/discord-response-system-prompt.md",
    "/ai-config/discord-response-system-prompt.md",
  ];
  for (const path of sourceFilePaths) {
    const response = await worker.fetch(
      new Request(`https://example.com${path}`, { method: "GET" }),
      env,
      { waitUntil: () => undefined } as never,
    );
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), "Not found", path);
  }

  const unknownGatewayWithoutAuth = await worker.fetch(
    new Request("https://example.com/gateway/unknown", { method: "POST" }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(unknownGatewayWithoutAuth.status, 404);

  const unknownGateway = await worker.fetch(
    new Request("https://example.com/gateway/unknown", {
      method: "POST",
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    { waitUntil: () => undefined } as never,
  );
  assert.equal(unknownGateway.status, 404);
  assert.equal(gatewayFetchCalls, 0);
});
