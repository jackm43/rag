import test from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import nacl from "tweetnacl";

import worker, {
  DiscordGateway,
  extractBotMentionPrompt,
  handleGatewayMessageCreate,
} from "../src/index.ts";

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

// DB mock that supports prepare().run(), prepare().bind().run(), and first().
const createDbMock = (options: {
  roasts?: Array<{ roast_text: string }>;
  ragCount?: number;
  reportCount?: number;
  onBatch?: (statements: Array<{ sql: string; args: unknown[] }>) => void;
}) => ({
  batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
    options.onBatch?.(statements);
  },
  prepare: (sql: string) => {
    const runner = (args: unknown[]) => ({
      sql,
      args,
      run: async () => {
        if (sql.includes("rag_roasts")) {
          return { results: options.roasts ?? [] };
        }
        return { results: undefined };
      },
      first: async () => {
        if (sql.includes("SELECT rag_count")) {
          return { rag_count: options.ragCount ?? 1 };
        }
        if (sql.includes("SELECT COUNT")) {
          return { report_count: options.reportCount ?? 1 };
        }
        return null;
      },
      all: async () => ({ results: [], meta: {} }),
    });
    return {
      ...runner([]),
      bind: (...args: unknown[]) => runner(args),
    };
  },
});

test("GET / returns ok", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = new Request("https://example.com/", { method: "GET" });

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("non-POST methods return 405", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = new Request("https://example.com/interactions", { method: "PUT" });

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 405);
  assert.equal(await response.text(), "Method not allowed");
});

test("invalid Discord signature returns 401", async () => {
  const validPair = nacl.sign.keyPair();
  const mismatchedPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(validPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, mismatchedPair.secretKey);

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("malformed signature header returns 401 without throwing", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = new Request("https://example.com/interactions", {
    method: "POST",
    headers: {
      "x-signature-ed25519": "not-hex!",
      "x-signature-timestamp": "123",
    },
    body: "{}",
  });

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
});

test("PING interaction returns Discord pong payload", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey);

  const response = await worker.fetch(request, env, {} as never);

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

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: "Unknown command." },
  });
});

test("/rag interaction is deferred and edits the original response from waitUntil", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  const waitUntilPromises: Promise<unknown>[] = [];

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DB: createDbMock({ ragCount: 7, reportCount: 3 }),
      AI: {
        run: async () => ({ response: "Alice booked the scoreboard, and Bob keeps signing receipts." }),
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "rag",
          options: [{ name: "user", value: "2" }],
          resolved: {
            users: { "2": { id: "2", username: "bob", global_name: "Bob" } },
          },
        },
        member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
      },
      keyPair.secretKey,
    );
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    };

    const response = await worker.fetch(request, env, ctx as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5 });

    await Promise.all(waitUntilPromises);

    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].url,
      "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.equal(fetchCalls[0].init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      content: "<@2> has just ragged. Total: 7\nAlice booked the scoreboard, and Bob keeps signing receipts.",
      allowed_mentions: {
        parse: [],
        users: ["2"],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/rag interaction fetches target username when Discord does not include resolved users", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const batchStatements: Array<{ sql: string; args: unknown[] }> = [];
  const fetchCalls: string[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push(String(url));
    if (String(url) === "https://discord.com/api/v10/users/2") {
      assert.deepEqual(init?.headers, { authorization: "Bot bot-token" });
      return Response.json({ id: "2", username: "bob" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({
        onBatch: (statements) => {
          batchStatements.push(...statements);
        },
      }),
      AI: {
        run: async () => ({ response: "Alice rang the bell, and someone added another mark." }),
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "rag",
          options: [{ name: "user", value: "2" }],
        },
        member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5 });
    await Promise.all(waitUntilPromises);

    assert.ok(fetchCalls.includes("https://discord.com/api/v10/users/2"));
    assert.deepEqual(batchStatements[0].args, ["2", "bob", "1", "alice"]);
    assert.deepEqual(batchStatements[1].args, ["2", "bob"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/rag retries the roast generation when the model repeats a recent line", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  const duplicateLine = "Bob did the exact same thing again today.";
  const freshLine = "Bob set a brand new personal record for chaos.";
  const aiResponses = [duplicateLine, freshLine];
  let aiCalls = 0;
  const waitUntilPromises: Promise<unknown>[] = [];

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DB: createDbMock({
        ragCount: 4,
        reportCount: 2,
        roasts: [{ roast_text: duplicateLine }],
      }),
      AI: {
        run: async () => {
          aiCalls += 1;
          return { response: aiResponses.shift() ?? freshLine };
        },
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "rag",
          options: [{ name: "user", value: "2" }],
          resolved: {
            users: { "2": { id: "2", username: "bob", global_name: "Bob" } },
          },
        },
        member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5 });
    await Promise.all(waitUntilPromises);

    // The first generation duplicated a recent roast, so it must retry rather
    // than fall back to a canned line.
    assert.equal(aiCalls, 2);
    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.content, `<@2> has just ragged. Total: 4\n${freshLine}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/rag uses the model's line over a canned fallback even when it repeats", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  // Every attempt returns a line that already exists in recent roasts.
  const repeatedLine = "Bob keeps speedrunning bad decisions while Alice keeps the receipts.";
  let aiCalls = 0;
  const waitUntilPromises: Promise<unknown>[] = [];

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DB: createDbMock({
        ragCount: 9,
        reportCount: 5,
        roasts: [{ roast_text: repeatedLine }],
      }),
      AI: {
        run: async () => {
          aiCalls += 1;
          return { response: repeatedLine };
        },
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "rag",
          options: [{ name: "user", value: "2" }],
          resolved: {
            users: { "2": { id: "2", username: "bob", global_name: "Bob" } },
          },
        },
        member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as never);

    assert.equal(response.status, 200);
    await Promise.all(waitUntilPromises);

    // It exhausts its attempts trying for something fresh, then still returns
    // the model's line rather than a canned fallback.
    assert.equal(aiCalls, 3);
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.content, `<@2> has just ragged. Total: 9\n${repeatedLine}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bot mention parser accepts prompts after the bot mention", () => {
  assert.equal(extractBotMentionPrompt("<@bot-user-id> Explain queues", "bot-user-id"), "Explain queues");
  assert.equal(extractBotMentionPrompt("<@!bot-user-id>    Explain queues", "bot-user-id"), "Explain queues");
  assert.equal(extractBotMentionPrompt("hey <@bot-user-id>", "bot-user-id"), "hey");
  assert.equal(extractBotMentionPrompt("what's up <@bot-user-id>", "bot-user-id"), "what's up");
  assert.equal(extractBotMentionPrompt("<@application-id> Explain queues", "bot-user-id"), null);
  assert.equal(
    extractBotMentionPrompt("<@application-id> Explain queues", "bot-user-id", "application-id"),
    "Explain queues",
  );
  assert.equal(extractBotMentionPrompt("!ai Explain queues", "bot-user-id"), null);
  assert.equal(extractBotMentionPrompt("<@bot-user-id>   ", "bot-user-id"), null);
});

test("gateway message create enqueues a raw channel AI job", async () => {
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
      messageId: "message-id",
      botUserId: "bot-user-id",
      requesterUserId: "1",
      requesterUsername: "alice",
      prompt: "Explain queues",
      replyMessageId: undefined,
      replyContext: undefined,
    },
  ]);
});

test("gateway message create enqueues jobs when the bot is mentioned at the end", async () => {
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
      content: "hey <@bot-user-id>",
      mentions: [{ id: "bot-user-id" }],
      author: { id: "1", username: "alice" },
    },
    env,
    "bot-user-id",
  );

  assert.deepEqual(queuedJobs, [
    {
      kind: "channel",
      channelId: "channel-id",
      messageId: "message-id",
      botUserId: "bot-user-id",
      requesterUserId: "1",
      requesterUsername: "alice",
      prompt: "hey",
      replyMessageId: undefined,
      replyContext: undefined,
    },
  ]);
});

test("gateway message create enqueues jobs when the bot's role is mentioned", async () => {
  const originalFetch = globalThis.fetch;
  const queuedJobs: unknown[] = [];
  const fetchCalls: string[] = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return Response.json({ roles: ["bot-role-id"] });
  };
  const env = createEnv("unused", {
    DISCORD_BOT_TOKEN: "bot-token",
    AI_JOBS: {
      send: async (job: unknown) => {
        queuedJobs.push(job);
      },
    },
  });

  try {
    await handleGatewayMessageCreate(
      {
        id: "message-id",
        guild_id: "guild-id",
        channel_id: "channel-id",
        content: "<@&bot-role-id> whats up",
        mention_roles: ["bot-role-id"],
        author: { id: "1", username: "alice" },
      },
      env,
      "bot-user-id",
    );

    assert.deepEqual(fetchCalls, [
      "https://discord.com/api/v10/guilds/guild-id/members/bot-user-id",
    ]);
    assert.deepEqual(queuedJobs, [
      {
        kind: "channel",
        channelId: "channel-id",
        messageId: "message-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "alice",
        prompt: "whats up",
        replyMessageId: undefined,
        replyContext: undefined,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway message create includes replied-to message content in the job", async () => {
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
      messageId: "message-id",
      botUserId: "bot-user-id",
      requesterUserId: "1",
      requesterUsername: "alice",
      prompt: "Summarize this",
      replyMessageId: "referenced-message-id",
      replyContext: "Replied-to message from bob:\nWorkers queues deliver AI jobs asynchronously.",
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
        messageId: "message-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "alice",
        prompt: "what does this say",
        replyMessageId: "referenced-message-id",
        replyContext:
          "Replied-to message from bob:\nThis label says approved for launch.\nAttachment: label.png (image/png) https://cdn.discordapp.com/attachments/label.png",
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

test("worker rejects /gateway/start without bot token auth", async () => {
  let doFetchCalls = 0;
  const env = createEnv("unused", {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GATEWAY: {
      idFromName: () => "id",
      get: () => ({
        fetch: async () => {
          doFetchCalls += 1;
          return Response.json({ ok: true });
        },
      }),
    },
  });

  const unauthorized = await worker.fetch(
    new Request("https://example.com/gateway/start", { method: "POST" }),
    env,
    {} as never,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(doFetchCalls, 0);

  const authorized = await worker.fetch(
    new Request("https://example.com/gateway/start", {
      method: "POST",
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    {} as never,
  );
  assert.equal(authorized.status, 200);
  assert.equal(doFetchCalls, 1);
});

test("gateway durable object persists enabled state and schedules an alarm", async () => {
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
    const response = await gateway.fetch(
      new Request("https://example.com/gateway/start", { method: "POST" }),
    );

    assert.equal(response.status, 200);
    assert.equal(storedValues.get("gatewayEnabled"), true);
    assert.equal(alarmTimes.length, 1);
    assert.ok(alarmTimes[0] > Date.now());
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("queue handler builds a conversation from channel history and posts the reply", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("/messages?")) {
      // Discord returns newest-first.
      return Response.json([
        {
          id: "m3",
          channel_id: "channel-id",
          content: "anyone know how queues work",
          author: { id: "1", username: "alice" },
        },
        {
          id: "m2",
          channel_id: "channel-id",
          content: "Queues deliver messages asynchronously.",
          author: { id: "bot-user-id", username: "ragbot", bot: true },
        },
        {
          id: "m1",
          channel_id: "channel-id",
          content: "<@999000000000000001> hello",
          author: { id: "2", username: "bob" },
        },
      ]);
    }
    return new Response("{}", { status: 200 });
  };

  const aiInputs: unknown[] = [];

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({}),
      AI: {
        run: async (_model: unknown, input: unknown) => {
          aiInputs.push(input);
          return { response: "Short answer." };
        },
      },
    });
    const ackedMessages: unknown[] = [];
    const message = {
      body: {
        kind: "channel",
        channelId: "channel-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "alice",
        prompt: "and what about retries",
      },
      ack: () => {
        ackedMessages.push(message.body);
      },
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    const historyCall = fetchCalls.find((call) => call.url.includes("/messages?"));
    assert.ok(historyCall);
    assert.equal(
      historyCall.url,
      "https://discord.com/api/v10/channels/channel-id/messages?before=trigger-id&limit=12",
    );

    assert.equal(aiInputs.length, 1);
    const input = aiInputs[0] as { messages: Array<{ role: string; content: string }> };
    assert.equal(input.messages[0].role, "system");
    assert.deepEqual(input.messages.slice(1), [
      { role: "user", content: "bob: hello" },
      { role: "assistant", content: "Queues deliver messages asynchronously." },
      { role: "user", content: "alice: anyone know how queues work" },
      { role: "user", content: "alice: and what about retries" },
    ]);

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/channel-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content: "Short answer.",
      allowed_mentions: {
        parse: [],
      },
    });
    assert.deepEqual(ackedMessages, [message.body]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler sanitizes mentions and IDs from the model output", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({}),
      AI: {
        run: async () => ({ response: "Hello <@123456789012345678> there 123456789012345678" }),
      },
    });
    const message = {
      body: {
        kind: "channel",
        channelId: "channel-id",
        prompt: "Say hello",
      },
      ack: () => undefined,
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "https://discord.com/api/v10/channels/channel-id/messages");
    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      content: "Hello there",
      allowed_mentions: {
        parse: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler uses the source-controlled partner model and parses the OpenAI response shape", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };
  const aiCalls: Array<{ model: unknown; input: Record<string, unknown> }> = [];

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock(),
      AI: {
        run: async (model: unknown, input: unknown, options: unknown) => {
          aiCalls.push({ model, input: input as Record<string, unknown> });
          assert.deepEqual(options, { gateway: { id: "platy" } });
          return { choices: [{ message: { content: "grok response" } }] };
        },
      },
    });
    const message = {
      body: {
        kind: "channel",
        channelId: "channel-id",
        prompt: "Say hello",
      },
      ack: () => undefined,
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    assert.equal(aiCalls.length, 1);
    assert.equal(aiCalls[0].model, "grok/grok-4.3");
    assert.equal(aiCalls[0].input.max_completion_tokens, 256);
    assert.equal(aiCalls[0].input.max_tokens, undefined);

    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      content: "grok response",
      allowed_mentions: {
        parse: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler calls AI Gateway directly when gateway credentials are configured", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const insertedInteractions: Array<{ sql: string; args: unknown[] }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({
        model: "grok/grok-4.3",
        choices: [{ message: { content: "Ragbot: gateway response" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock({
        onBatch: () => undefined,
      }),
      AI: {
        run: async () => {
          throw new Error("AI binding should not be used when AI Gateway credentials are configured");
        },
      },
    });
    env.DB = {
      ...env.DB,
      prepare: (sql: string) => {
        const base = createDbMock().prepare(sql);
        return {
          ...base,
          bind: (...args: unknown[]) => ({
            ...base.bind(...args),
            run: async () => {
              if (sql.includes("INSERT INTO rag_ai_interactions")) {
                insertedInteractions.push({ sql, args });
              }
              return base.bind(...args).run();
            },
          }),
        };
      },
    } as never;
    const message = {
      body: {
        kind: "channel",
        channelId: "channel-id",
        prompt: "Say hello",
      },
      ack: () => undefined,
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    const gatewayCall = fetchCalls.find((call) => call.url.includes("gateway.ai.cloudflare.com"));
    assert.ok(gatewayCall);
    assert.equal(
      gatewayCall.url,
      "https://gateway.ai.cloudflare.com/v1/account-id/platy/compat/chat/completions",
    );
    assert.equal(new Headers(gatewayCall.init?.headers).get("cf-aig-authorization"), "Bearer gateway-token");
    assert.deepEqual(JSON.parse(String(gatewayCall.init?.body)), {
      model: "grok/grok-4.3",
      messages: [
        {
          role: "system",
          content:
            "You are Ragbot, a bot in a casual Discord server for friends. Reply in plain text, briefly and directly. Default to one or two short sentences and match the length of your reply to the question. Dry humour is welcome when it fits, but never force banter and never pad your answers. Only write something long when the question genuinely needs it.",
        },
        { role: "user", content: "user: Say hello" },
      ],
      max_tokens: 256,
      temperature: 0.7,
    });

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/channel-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content: "gateway response",
      allowed_mentions: {
        parse: [],
      },
    });
    assert.equal(insertedInteractions.length, 1);
    assert.ok(insertedInteractions[0].sql.includes("prompt_tokens"));
    assert.deepEqual(insertedInteractions[0].args.slice(-3), [10, 2, 12]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// OIDC tests use a fake Access for SaaS issuer: a real RS256 keypair whose
// public JWKS is served from the per-application endpoint via a mocked fetch.
const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
const OIDC_CLIENT_ID = "oidc-client-id";

const oidcIssuer = await (async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const signToken = (audience = OIDC_CLIENT_ID) =>
    new SignJWT({ email: "admin@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience(audience)
      .setSubject("access-user-sub")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  const fetchMock = async (url: unknown): Promise<Response> => {
    if (String(url) === `${TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${OIDC_CLIENT_ID}/jwks`) {
      return Response.json({ keys: [jwk] });
    }
    return new Response("{}", { status: 200 });
  };

  return { signToken, fetchMock };
})();

const createOidcEnv = (overrides: Record<string, unknown> = {}) =>
  createEnv("unused", {
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_OIDC_CLIENT_ID: OIDC_CLIENT_ID,
    ...overrides,
  });

test("oauth config endpoint publishes client metadata and fails closed when unset", async () => {
  const configured = await worker.fetch(
    new Request("https://example.com/oauth/config", { method: "GET" }),
    createOidcEnv(),
    {} as never,
  );
  assert.equal(configured.status, 200);
  assert.deepEqual(await configured.json(), {
    issuer: TEAM_DOMAIN,
    client_id: OIDC_CLIENT_ID,
    authorization_endpoint: `${TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${OIDC_CLIENT_ID}/authorization`,
    token_endpoint: `${TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${OIDC_CLIENT_ID}/token`,
  });

  const unconfigured = await worker.fetch(
    new Request("https://example.com/oauth/config", { method: "GET" }),
    createEnv("unused"),
    {} as never,
  );
  assert.equal(unconfigured.status, 503);
});

test("admin API rejects requests when OIDC is not configured", async () => {
  const env = createEnv("unused");
  const response = await worker.fetch(
    new Request("https://example.com/admin/config", {
      method: "GET",
      headers: { authorization: `Bearer ${await oidcIssuer.signToken()}` },
    }),
    env,
    {} as never,
  );
  assert.equal(response.status, 401);
});

test("admin API rejects requests without a valid bearer token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = oidcIssuer.fetchMock as never;

  try {
    const env = createOidcEnv();

    const missingToken = await worker.fetch(
      new Request("https://example.com/admin/config", { method: "GET" }),
      env,
      {} as never,
    );
    assert.equal(missingToken.status, 401);

    const invalidBearer = await worker.fetch(
      new Request("https://example.com/admin/config", {
        method: "GET",
        headers: { authorization: "Bearer not-a-jwt" },
      }),
      env,
      {} as never,
    );
    assert.equal(invalidBearer.status, 401);

    const wrongAudience = await worker.fetch(
      new Request("https://example.com/admin/config", {
        method: "GET",
        headers: { authorization: `Bearer ${await oidcIssuer.signToken("another-app")}` },
      }),
      env,
      {} as never,
    );
    assert.equal(wrongAudience.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin API accepts an Access-issued OIDC token and reports identity", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = oidcIssuer.fetchMock as never;

  try {
    const env = createOidcEnv();
    const whoami = await worker.fetch(
      new Request("https://example.com/admin/whoami", {
        method: "GET",
        headers: { authorization: `Bearer ${await oidcIssuer.signToken()}` },
      }),
      env,
      {} as never,
    );

    assert.equal(whoami.status, 200);
    assert.deepEqual(await whoami.json(), {
      identity: {
        sub: "access-user-sub",
        email: "admin@example.com",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
