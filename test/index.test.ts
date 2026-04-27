import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";

import worker from "../src/index.ts";

const encoder = new TextEncoder();

const createSignedRequest = (payload: unknown, secretKey: Uint8Array) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(payload);
  const message = encoder.encode(timestamp + rawBody);
  const signature = nacl.sign.detached(message, secretKey);
  const signatureHex = Buffer.from(signature).toString("hex");

  return new Request("https://example.com/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signatureHex,
      "x-signature-timestamp": timestamp,
    },
    body: rawBody,
  });
};

const createEnv = (publicKeyHex: string, overrides: Record<string, unknown> = {}) =>
  ({
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_APPLICATION_ID: "app-id",
    DB: {
      prepare: () => {
        throw new Error("DB should not be used in this test");
      },
      batch: () => {
        throw new Error("DB should not be used in this test");
      },
    },
    AI: {
      run: () => {
        throw new Error("AI should not be used in this test");
      },
    },
    AI_JOBS: {
      send: () => {
        throw new Error("AI_JOBS should not be used in this test");
      },
    },
    ...overrides,
  }) as never;

test("GET / returns ok", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = new Request("https://example.com/interactions", { method: "GET" });

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("non-POST methods return 405", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = new Request("https://example.com/interactions", { method: "PUT" });

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 405);
  assert.equal(await response.text(), "Method not allowed");
});

test("invalid Discord signature returns 401", async () => {
  const validPair = nacl.sign.keyPair();
  const mismatchedPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(validPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, mismatchedPair.secretKey);

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("PING interaction returns Discord pong payload", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey);

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 1 });
});

test("unknown command returns unknown command message", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest(
    {
      type: 2,
      data: { name: "does-not-exist" },
      user: { id: "1", username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: "Unknown command." },
  });
});

test("/ai enqueues a job and returns deferred response", async () => {
  const keyPair = nacl.sign.keyPair();
  const queuedJobs: unknown[] = [];
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    AI_JOBS: {
      send: async (job: unknown) => {
        queuedJobs.push(job);
      },
    },
  });
  const request = createSignedRequest(
    {
      type: 2,
      token: "interaction-token",
      data: {
        name: "ai",
        options: [{ name: "prompt", value: "Explain queues" }],
      },
      user: { id: "1", username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 5, data: {} });
  assert.deepEqual(queuedJobs, [
    {
      applicationId: "app-id",
      interactionToken: "interaction-token",
      prompt: "Explain queues",
    },
  ]);
});

test("/ai validates an empty prompt synchronously", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest(
    {
      type: 2,
      token: "interaction-token",
      data: {
        name: "ai",
        options: [{ name: "prompt", value: "   " }],
      },
      user: { id: "1", username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: "A prompt is required." },
  });
});

test("queue handler patches the deferred Discord response", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      AI: {
        run: async () => ({ response: "Hello <@123456789012345678> @there 123456789012345678" }),
      },
    });
    const ackedMessages: unknown[] = [];
    const message = {
      body: {
        applicationId: "app-id",
        interactionToken: "interaction-token",
        prompt: "Say hello",
      },
      ack: () => {
        ackedMessages.push(message.body);
      },
      retry: () => {
        throw new Error("message should not be retried");
      },
    };
    const queueHandler = (
      worker as typeof worker & {
        queue: (batch: { messages: typeof message[] }, env: never) => Promise<void>;
      }
    ).queue;

    await queueHandler({ messages: [message] }, env);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "https://discord.com/api/v10/webhooks/app-id/interaction-token/messages/@original");
    assert.equal(fetchCalls[0].init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      content: "Hello there",
      allowed_mentions: {
        parse: [],
      },
    });
    assert.deepEqual(ackedMessages, [message.body]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
