import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";

import worker, { DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate } from "../src/index.ts";

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
    DISCORD_APPLICATION_ID: "application-id",
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

test("stale /ai interaction returns unknown command without enqueueing", async () => {
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
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: "Unknown command." },
  });
  assert.deepEqual(queuedJobs, []);
});

test("bot mention parser accepts prompts after the bot mention", () => {
  assert.equal(extractBotMentionPrompt("<@bot-user-id> Explain queues", "bot-user-id"), "Explain queues");
  assert.equal(extractBotMentionPrompt("<@!bot-user-id>    Explain queues", "bot-user-id"), "Explain queues");
  assert.equal(extractBotMentionPrompt("<@application-id> Explain queues", "bot-user-id"), null);
  assert.equal(extractBotMentionPrompt("!ai Explain queues", "bot-user-id"), null);
  assert.equal(extractBotMentionPrompt("<@bot-user-id>   ", "bot-user-id"), null);
});

test("gateway message create enqueues a channel AI response job", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    AI_JOBS: {
      send: async (job: unknown) => {
        queuedJobs.push(job);
      },
    },
  });

  await handleGatewayMessageCreate(
    {
      id: "message-id",
      channel_id: "channel-id",
      content: "<@bot-user-id> Explain queues",
      author: { id: "1", username: "alice" },
    },
    env,
    "bot-user-id",
  );

  assert.deepEqual(queuedJobs, [
    {
      kind: "channel",
      channelId: "channel-id",
      prompt: "Explain queues",
    },
  ]);
});

test("gateway message create includes replied-to message content as AI context", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    AI_JOBS: {
      send: async (job: unknown) => {
        queuedJobs.push(job);
      },
    },
  });

  await handleGatewayMessageCreate(
    {
      id: "message-id",
      channel_id: "channel-id",
      content: "<@bot-user-id> Summarize this",
      author: { id: "1", username: "alice" },
      referenced_message: {
        id: "referenced-message-id",
        channel_id: "channel-id",
        content: "Workers queues deliver AI jobs asynchronously.",
        author: { id: "2", username: "bob" },
      },
    },
    env,
    "bot-user-id",
  );

  assert.deepEqual(queuedJobs, [
    {
      kind: "channel",
      channelId: "channel-id",
      prompt:
        "Replied-to message from bob:\nWorkers queues deliver AI jobs asynchronously.\n\nUser message:\nSummarize this",
    },
  ]);
});

test("gateway message create fetches referenced messages when Discord omits inline context", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const queuedJobs: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return Response.json({
      id: "referenced-message-id",
      channel_id: "referenced-channel-id",
      content: "This label says approved for launch.",
      author: { id: "2", username: "bob" },
      attachments: [
        {
          id: "attachment-id",
          filename: "label.png",
          content_type: "image/png",
          url: "https://cdn.discordapp.com/attachments/label.png",
        },
      ],
    });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      AI_JOBS: {
        send: async (job: unknown) => {
          queuedJobs.push(job);
        },
      },
    });

    await handleGatewayMessageCreate(
      {
        id: "message-id",
        channel_id: "channel-id",
        content: "<@bot-user-id> what does this say",
        author: { id: "1", username: "alice" },
        message_reference: {
          channel_id: "referenced-channel-id",
          message_id: "referenced-message-id",
        },
      },
      env,
      "bot-user-id",
    );

    assert.deepEqual(fetchCalls, [
      {
        url: "https://discord.com/api/v10/channels/referenced-channel-id/messages/referenced-message-id",
        init: {
          headers: {
            authorization: "Bot bot-token",
          },
        },
      },
    ]);
    assert.deepEqual(queuedJobs, [
      {
        kind: "channel",
        channelId: "channel-id",
        prompt:
          "Replied-to message from bob:\nThis label says approved for launch.\nAttachment: label.png (image/png) https://cdn.discordapp.com/attachments/label.png\n\nUser message:\nwhat does this say",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway message create ignores bots and empty mention prompts", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    AI_JOBS: {
      send: async (job: unknown) => {
        queuedJobs.push(job);
      },
    },
  });

  await handleGatewayMessageCreate(
    {
      id: "bot-message-id",
      channel_id: "channel-id",
      content: "<@bot-user-id> Explain queues",
      author: { id: "2", username: "bot", bot: true },
    },
    env,
    "bot-user-id",
  );
  await handleGatewayMessageCreate(
    {
      id: "empty-message-id",
      channel_id: "channel-id",
      content: "<@bot-user-id>   ",
      author: { id: "1", username: "alice" },
    },
    env,
    "bot-user-id",
  );
  await handleGatewayMessageCreate(
    {
      id: "legacy-prefix-message-id",
      channel_id: "channel-id",
      content: "!ai Explain queues",
      author: { id: "1", username: "alice" },
    },
    env,
    "bot-user-id",
  );

  assert.deepEqual(queuedJobs, []);
});

test("gateway start persists enabled state and schedules an alarm", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const storedValues = new Map<string, unknown>();
  const alarmTimes: number[] = [];
  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    constructor(readonly url: string) {
      super();
    }
    send() { }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  globalThis.WebSocket = FakeWebSocket as never;

  try {
    const gateway = new DiscordGateway(
      {
        storage: {
          get: async (key: string) => storedValues.get(key),
          put: async (key: string, value: unknown) => {
            storedValues.set(key, value);
          },
          setAlarm: async (scheduledTime: number) => {
            alarmTimes.push(scheduledTime);
          },
        },
      } as never,
      createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" }),
    );
    const response = await gateway.fetch(new Request("https://example.com/gateway/start", {
      method: "POST",
      headers: { authorization: "Bearer bot-token" },
    }));

    assert.equal(response.status, 200);
    assert.equal(storedValues.get("gatewayEnabled"), true);
    assert.equal(alarmTimes.length, 1);
    assert.ok(alarmTimes[0] > Date.now());
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("queue handler posts channel AI responses for prefix commands", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      AI: {
        run: async () => ({ response: "Hello <@123456789012345678> @there 123456789012345678" }),
      },
    });
    const ackedMessages: unknown[] = [];
    const message = {
      body: {
        kind: "channel",
        channelId: "channel-id",
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
    assert.equal(fetchCalls[0].url, "https://discord.com/api/v10/channels/channel-id/messages");
    assert.equal(fetchCalls[0].init?.method, "POST");
    assert.equal(fetchCalls[0].init?.headers instanceof Headers, false);
    assert.deepEqual(fetchCalls[0].init?.headers, {
      authorization: "Bot bot-token",
      "content-type": "application/json",
    });
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
