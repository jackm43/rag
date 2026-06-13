import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";

import worker, {
  DiscordGateway,
  extractBotMentionPrompt,
  extractReplyToBotPrompt,
  handleGatewayMessageCreate,
  resolveChannelPrompt,
} from "../src/index.ts";
import { sanitizeAiText } from "../src/ai.ts";
import {
  authGatewayFetch,
  createAigatewayEnv,
  GATEWAY_ISSUER,
  signToken,
  type AiCompleteRequest,
} from "./aigateway-mock.ts";

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
    AI_JOBS: {
      send: () => {
        throw new Error("AI_JOBS should not be used in this test");
      },
    },
    ...overrides,
  }) as never;

const stsEnv = (overrides: Record<string, unknown> = {}) =>
  createEnv("unused", {
    AUTH_GATEWAY_URL: GATEWAY_ISSUER,
    ...overrides,
  });

// DB mock that supports both prepare().run() (settings load) and
// prepare().bind().run()/first() (everything else).
const createDbMock = (options: {
  settings?: Array<{ key: string; value: string }>;
  roasts?: Array<{ roast_text: string }>;
  ragCount?: number;
  reportCount?: number;
  answeredMessageIds?: Set<string>;
  onBatch?: (statements: Array<{ sql: string; args: unknown[] }>) => void;
}) => {
  const claimedMessageIds = new Set<string>();
  return {
    batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
      options.onBatch?.(statements);
    },
    prepare: (sql: string) => {
      const runner = (args: unknown[]) => ({
        sql,
        args,
        run: async () => {
          if (sql.includes("rag_message_jobs")) {
            const messageId = String(args[0]);
            if (claimedMessageIds.has(messageId)) {
              return { meta: { changes: 0 } };
            }
            claimedMessageIds.add(messageId);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO rag_ai_interactions")) {
            return { meta: { changes: 1 } };
          }
          if (sql.includes("rag_settings")) {
            return { results: options.settings ?? [] };
          }
          if (sql.includes("rag_roasts")) {
            return { results: options.roasts ?? [] };
          }
          return { results: undefined };
        },
        first: async () => {
          if (sql.includes("rag_ai_interactions") && sql.includes("status = 'ok'")) {
            const messageId = String(args[0]);
            return options.answeredMessageIds?.has(messageId) ? { id: 1 } : null;
          }
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
  };
};

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
    const aiHarness = createAigatewayEnv({
      complete: () => ({ content: "Alice booked the scoreboard, and Bob keeps signing receipts." }),
    });
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DB: createDbMock({ ragCount: 7, reportCount: 3 }),
      ...aiHarness.env,
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
    const aiHarness = createAigatewayEnv({
      complete: () => ({ content: "Alice rang the bell, and someone added another mark." }),
    });
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({
        onBatch: (statements) => {
          batchStatements.push(...statements);
        },
      }),
      ...aiHarness.env,
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
  const waitUntilPromises: Promise<unknown>[] = [];

  try {
    const aiHarness = createAigatewayEnv({
      complete: (_request, index) => ({
        content: aiResponses[index] ?? freshLine,
      }),
    });
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DB: createDbMock({
        ragCount: 4,
        reportCount: 2,
        roasts: [{ roast_text: duplicateLine }],
      }),
      ...aiHarness.env,
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
    assert.equal(aiHarness.completeCalls.length, 2);
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
  const waitUntilPromises: Promise<unknown>[] = [];

  try {
    const aiHarness = createAigatewayEnv({
      complete: () => ({ content: repeatedLine }),
    });
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DB: createDbMock({
        ragCount: 9,
        reportCount: 5,
        roasts: [{ roast_text: repeatedLine }],
      }),
      ...aiHarness.env,
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
    assert.equal(aiHarness.completeCalls.length, 3);
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.content, `<@2> has just ragged. Total: 9\n${repeatedLine}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bot mention parser accepts prompts after the bot mention", () => {
  assert.equal(extractBotMentionPrompt("<@bot-user-id> Explain queues", "bot-user-id"), "Explain queues");
  assert.equal(extractBotMentionPrompt("<@!bot-user-id>    Explain queues", "bot-user-id"), "Explain queues");
  assert.equal(extractBotMentionPrompt("hey <@bot-user-id> what's up", "bot-user-id"), "hey what's up");
  assert.equal(extractBotMentionPrompt("what do you think <@bot-user-id>", "bot-user-id"), "what do you think");
  assert.equal(extractBotMentionPrompt("<@application-id> Explain queues", "bot-user-id"), null);
  assert.equal(extractBotMentionPrompt("!ai Explain queues", "bot-user-id"), null);
  assert.equal(extractBotMentionPrompt("<@bot-user-id>   ", "bot-user-id"), null);
  assert.equal(extractBotMentionPrompt("hey <@bot-user-id>", "bot-user-id"), "hey");
});

test("bot mention parser accepts leading mentions from Discord metadata alone", () => {
  assert.deepEqual(
    resolveChannelPrompt(
      { content: "hey", mentions: [{ id: "bot-user-id" }] },
      "bot-user-id",
    ),
    { prompt: "hey", source: "mention" },
  );
  assert.deepEqual(
    resolveChannelPrompt(
      { content: "<@other-id> hey", mentions: [{ id: "bot-user-id" }] },
      "bot-user-id",
    ),
    { prompt: "hey", source: "mention" },
  );
});

test("reply-to-bot parser accepts prompts without a leading mention", () => {
  assert.equal(extractReplyToBotPrompt("keep going", "bot-user-id", "bot-user-id"), "keep going");
  assert.equal(extractReplyToBotPrompt("<@bot-user-id> keep going", "bot-user-id", "bot-user-id"), "keep going");
  assert.equal(extractReplyToBotPrompt("keep going", "other-user-id", "bot-user-id"), null);
  assert.equal(extractReplyToBotPrompt("   ", "bot-user-id", "bot-user-id"), null);
});

test("channel prompt resolver prefers a leading mention over a reply", () => {
  assert.deepEqual(
    resolveChannelPrompt({ content: "<@bot-user-id> hi" }, "bot-user-id", "bot-user-id"),
    { prompt: "hi", source: "mention" },
  );
  assert.deepEqual(
    resolveChannelPrompt({ content: "just a reply" }, "bot-user-id", "bot-user-id"),
    { prompt: "just a reply", source: "reply" },
  );
  assert.equal(
    resolveChannelPrompt({ content: "just a reply" }, "bot-user-id", "other-user-id"),
    null,
  );
});

test("channel prompt resolver accepts application id mentions", () => {
  assert.deepEqual(
    resolveChannelPrompt({ content: "<@app-id> hey" }, "bot-user-id", undefined, "app-id"),
    { prompt: "hey", source: "mention" },
  );
});

test("channel prompt resolver accepts numeric mention ids from Discord metadata", () => {
  const id = "1234567890123456";
  assert.deepEqual(
    resolveChannelPrompt(
      { content: "hey", mentions: [{ id: Number(id) as unknown as string }] },
      id,
    ),
    { prompt: "hey", source: "mention" },
  );
});

test("channel prompt resolver accepts mentions of a role the bot holds", () => {
  assert.deepEqual(
    resolveChannelPrompt(
      { content: "<@&bot-role-id> how u doin", mention_roles: ["bot-role-id"] },
      "bot-user-id",
      undefined,
      undefined,
      ["bot-role-id"],
    ),
    { prompt: "how u doin", source: "mention" },
  );
  assert.equal(
    resolveChannelPrompt(
      { content: "<@&bot-role-id> how u doin", mention_roles: ["bot-role-id"] },
      "bot-user-id",
      undefined,
      undefined,
      ["other-role-id"],
    ),
    null,
  );
  assert.deepEqual(
    resolveChannelPrompt({ content: "<@&bot-role-id> how u doin" }, "bot-user-id", undefined, undefined, [
      "bot-role-id",
    ]),
    { prompt: "how u doin", source: "mention" },
  );
});

test("gateway message create enqueues jobs for a leading mention", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    DB: createDbMock({}),
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
      content: "<@bot-user-id> hey",
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
      promptSource: "mention",
      replyMessageId: undefined,
      replyContext: undefined,
    },
  ]);
});

test("gateway message create enqueues jobs when the bot is mentioned mid-message", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    DB: createDbMock({}),
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
      content: "hey <@bot-user-id> what's up",
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
      prompt: "hey what's up",
      promptSource: "mention",
      replyMessageId: undefined,
      replyContext: undefined,
    },
  ]);
});

test("gateway message create enqueues jobs when the bot's role is mentioned", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  const queuedJobs: unknown[] = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return Response.json({ roles: ["bot-role-id"] });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({}),
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
        guild_id: "role-mention-guild",
        content: "<@&bot-role-id> how u doin",
        mention_roles: ["bot-role-id"],
        author: { id: "1", username: "alice" },
      },
      env,
      "bot-user-id",
    );

    assert.deepEqual(fetchCalls, [
      "https://discord.com/api/v10/guilds/role-mention-guild/members/bot-user-id",
    ]);
    assert.deepEqual(queuedJobs, [
      {
        kind: "channel",
        channelId: "channel-id",
        messageId: "message-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "alice",
        prompt: "how u doin",
        promptSource: "mention",
        replyMessageId: undefined,
        replyContext: undefined,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway message create skips duplicate jobs for the same message id", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    DB: createDbMock({}),
    AI_JOBS: {
      send: async (job: unknown) => {
        queuedJobs.push(job);
      },
    },
  });
  const message = {
    id: "message-id",
    channel_id: "channel-id",
    content: "<@bot-user-id> hey",
    mentions: [{ id: "bot-user-id" }],
    author: { id: "1", username: "alice" },
  };

  await handleGatewayMessageCreate(message, env, "bot-user-id");
  await handleGatewayMessageCreate(message, env, "bot-user-id");

  assert.equal(queuedJobs.length, 1);
});

test("gateway message create enqueues reply-to-bot jobs without a mention", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    DB: createDbMock({}),
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
      content: "keep the banter going",
      author: { id: "1", username: "._jak" },
      referenced_message: {
        id: "bot-message-id",
        channel_id: "channel-id",
        content: "previous bot reply",
        author: { id: "bot-user-id", username: "ragbot" },
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
      requesterUsername: "._jak",
      prompt: "keep the banter going",
      promptSource: "reply",
      replyMessageId: "bot-message-id",
      replyContext: "Replied-to message from ragbot:\nprevious bot reply",
    },
  ]);
});

test("interactions reject guilds outside the allowlist", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    ALLOWED_GUILD_IDS: "allowed-guild",
  });
  const request = createSignedRequest(
    {
      type: 2,
      guild_id: "other-guild",
      data: { name: "ragboard" },
      user: { id: "1", username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);
  const body = (await response.json()) as { data: { content: string } };

  assert.equal(response.status, 200);
  assert.match(body.data.content, /not enabled for this server/i);
});

test("gateway message create ignores guilds outside the allowlist", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    ALLOWED_GUILD_IDS: "allowed-guild",
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
      guild_id: "other-guild",
      content: "<@bot-user-id> Explain queues",
      author: { id: "1", username: "alice" },
    },
    env,
    "bot-user-id",
  );

  assert.deepEqual(queuedJobs, []);
});

test("gateway message create enqueues a raw channel AI job", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    DB: createDbMock({}),
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
      promptSource: "mention",
      replyMessageId: undefined,
      replyContext: undefined,
    },
  ]);
});

test("gateway message create includes replied-to message content in the job", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    DB: createDbMock({}),
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
      promptSource: "mention",
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
      DB: createDbMock({}),
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
        promptSource: "mention",
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

test("public gateway HTTP routes are disabled", async () => {
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

  const start = await worker.fetch(
    new Request("https://example.com/gateway/start", {
      method: "POST",
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    {} as never,
  );
  assert.equal(start.status, 404);
  assert.equal(doFetchCalls, 0);

  const health = await worker.fetch(
    new Request("https://example.com/gateway/health", { method: "GET" }),
    env,
    {} as never,
  );
  assert.equal(health.status, 404);
  assert.equal(doFetchCalls, 0);
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

  const aiInputs: AiCompleteRequest[] = [];

  try {
    const aiHarness = createAigatewayEnv({
      complete: (request) => {
        aiInputs.push(request);
        return { content: "Short answer." };
      },
    });
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({}),
      ...aiHarness.env,
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
    const input = aiInputs[0];
    assert.equal(input.messages[0].role, "system");
    assert.deepEqual(input.messages.slice(1), [
      { role: "user", content: "[bob] hello" },
      { role: "assistant", content: "Queues deliver messages asynchronously." },
      { role: "user", content: "[alice] anyone know how queues work" },
      { role: "user", content: "[alice] and what about retries" },
    ]);

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/channel-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content: "Short answer.",
    });
    assert.deepEqual(ackedMessages, [message.body]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler omits /rag announcement lines from channel history", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("/messages?")) {
      return Response.json([
        {
          id: "m2",
          channel_id: "channel-id",
          content: "target has just ragged. Total: 3\nYour mom is a hamplanet.",
          author: { id: "bot-user-id", username: "ragbot", bot: true },
        },
        {
          id: "m1",
          channel_id: "channel-id",
          content: "gm everyone",
          author: { id: "1", username: "alice" },
        },
      ]);
    }
    return new Response("{}", { status: 200 });
  };

  const aiInputs: AiCompleteRequest[] = [];

  try {
    const aiHarness = createAigatewayEnv({
      complete: (request) => {
        aiInputs.push(request);
        return { content: "Hey." };
      },
    });
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({}),
      ...aiHarness.env,
    });
    const message = {
      body: {
        kind: "channel",
        channelId: "channel-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "alice",
        prompt: "hey",
      },
      ack: () => undefined,
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    assert.equal(aiInputs.length, 1);
    const input = aiInputs[0];
    assert.deepEqual(input.messages.slice(1), [
      { role: "user", content: "[alice] gm everyone" },
      {
        role: "user",
        content:
          "[alice] hey\n\n(They only greeted you — reply warmly and briefly, no insults or roasts.)",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler posts model output without stripping mentions", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const aiHarness = createAigatewayEnv({
      complete: () => ({ content: "Hello <@123456789012345678> there 123456789012345678" }),
    });
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({}),
      ...aiHarness.env,
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
      content: "Hello <@123456789012345678> there 123456789012345678",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler skips jobs when the source message was already answered", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  try {
    let acked = false;
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({ answeredMessageIds: new Set(["trigger-id"]) }),
    });
    const message = {
      body: {
        kind: "channel",
        channelId: "channel-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "alice",
        prompt: "hey",
      },
      ack: () => {
        acked = true;
      },
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    assert.equal(acked, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sanitizeAiText strips leading fake speaker-colon lines from model output", () => {
  const raw =
    "_.jak: hey guy\n\n.jak. : hey buddy\n .jak: :)\n._jak : howdy\n\nHey, your grammar is more broken than your audio quality.";
  assert.equal(
    sanitizeAiText(raw),
    "Hey, your grammar is more broken than your audio quality.",
  );
});

test("queue handler uses mention model for @ragbot prompts and response model for replies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });

  try {
    const aiHarness = createAigatewayEnv({
      complete: (request) => ({ content: "ok", model: request.model }),
    });
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({
        settings: [
          { key: "ai_response_model", value: "@cf/meta/llama-3.1-8b-instruct" },
          { key: "ai_mention_model", value: "xai/grok-4.3" },
        ],
      }),
      ...aiHarness.env,
    });

    await worker.queue({
      messages: [
        {
          body: {
            kind: "channel",
            channelId: "channel-id",
            prompt: "Explain queues",
            promptSource: "mention",
          },
          ack: () => undefined,
          retry: () => {
            throw new Error("message should not be retried");
          },
        },
        {
          body: {
            kind: "channel",
            channelId: "channel-id",
            prompt: "keep going",
            promptSource: "reply",
          },
          ack: () => undefined,
          retry: () => {
            throw new Error("message should not be retried");
          },
        },
      ],
    } as never, env);

    assert.equal(aiHarness.completeCalls.length, 2);
    assert.equal(aiHarness.completeCalls[0].model, "xai/grok-4.3");
    assert.equal(aiHarness.completeCalls[1].model, "workers-ai/@cf/meta/llama-3.1-8b-instruct");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler uses a configured partner model and parses the OpenAI response shape", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const aiHarness = createAigatewayEnv({
      complete: (request) => ({ content: "grok response", model: request.model }),
    });
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      DB: createDbMock({
        settings: [{ key: "ai_response_model", value: "xai/grok-4.3" }],
      }),
      ...aiHarness.env,
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

    assert.equal(aiHarness.completeCalls.length, 1);
    assert.equal(aiHarness.completeCalls[0].model, "xai/grok-4.3");
    assert.equal(aiHarness.completeCalls[0].maxTokens, 96);

    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      content: "grok response",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Admin RPC tests use a fake auth gateway issuer: a real ES256 keypair whose
// public JWKS is served from the well-known endpoint via a mocked fetch.

const rpcRequest = (path: string, body: unknown, token?: string) =>
  new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const envelopConnectJSON = (payload: string) => {
  const body = new TextEncoder().encode(payload);
  const frame = new Uint8Array(5 + body.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, body.length, false);
  frame.set(body, 5);
  return frame;
};

const readConnectStream = async (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("missing response body");
  }
  const chunks: Array<Record<string, unknown>> = [];
  let buffer = new Uint8Array(0);
  const append = (value: Uint8Array) => {
    const next = new Uint8Array(buffer.length + value.length);
    next.set(buffer);
    next.set(value, buffer.length);
    buffer = next;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      append(value);
    }
    while (buffer.length >= 5) {
      const flags = buffer[0];
      const length = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0, false);
      if (buffer.length < 5 + length) {
        break;
      }
      const payload = buffer.slice(5, 5 + length);
      buffer = buffer.slice(5 + length);
      if (flags & 0x2) {
        if (length > 0) {
          const end = JSON.parse(new TextDecoder().decode(payload)) as { error?: { code?: string } };
          if (end.error?.code) {
            throw new Error(end.error.code);
          }
        }
        return chunks;
      }
      chunks.push(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
    }
    if (done) {
      return chunks;
    }
  }
};

const streamingRpcRequest = (path: string, body: unknown, token?: string) =>
  new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      "connect-content-encoding": "identity",
      "connect-accept-encoding": "identity",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: envelopConnectJSON(JSON.stringify(body)),
  });

test("admin RPCs reject requests when the auth gateway is not configured", async () => {
  const response = await worker.fetch(
    rpcRequest("/ragbot.v1.ConfigService/ListConfig", {}, await signToken()),
    createEnv("unused", { DB: createDbMock({}) }),
    {} as never,
  );
  assert.equal(response.status, 401);
});

test("admin RPCs reject missing, invalid, and wrong-audience tokens", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authGatewayFetch as never;

  try {
    const env = stsEnv({ DB: createDbMock({}) });

    const missingToken = await worker.fetch(
      rpcRequest("/ragbot.v1.ConfigService/ListConfig", {}),
      env,
      {} as never,
    );
    assert.equal(missingToken.status, 401);

    const invalidBearer = await worker.fetch(
      rpcRequest("/ragbot.v1.ConfigService/ListConfig", {}, "not-a-jwt"),
      env,
      {} as never,
    );
    assert.equal(invalidBearer.status, 401);

    const wrongAudience = await worker.fetch(
      rpcRequest(
        "/ragbot.v1.ConfigService/ListConfig",
        {},
        await signToken({ audience: "another-app" }),
      ),
      env,
      {} as never,
    );
    assert.equal(wrongAudience.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("config list RPC returns entries with a valid gateway token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authGatewayFetch as never;

  try {
    const env = stsEnv({
      DB: createDbMock({ settings: [{ key: "ai_response_model", value: "xai/grok-4.3" }] }),
    });
    const response = await worker.fetch(
      rpcRequest("/ragbot.v1.ConfigService/ListConfig", {}, await signToken()),
      env,
      {} as never,
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      entries: Array<{ key: string; value: string; overridden?: boolean }>;
    };
    const overridden = body.entries.find((entry) => entry.key === "ai_response_model");
    assert.equal(overridden?.value, "xai/grok-4.3");
    assert.equal(overridden?.overridden, true);
    assert.ok(body.entries.find((entry) => entry.key === "ai_temperature"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat RPC returns a model response for a mention-style prompt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authGatewayFetch as never;

  try {
    const aiHarness = createAigatewayEnv({
      complete: (request) => ({ content: "Short answer.", model: request.model }),
    });
    const env = stsEnv({
      DB: createDbMock({}),
      ...aiHarness.env,
    });
    const response = await worker.fetch(
      rpcRequest(
        "/ragbot.v1.ChatService/Chat",
        { prompt: "anyone know how queues work" },
        await signToken(),
      ),
      env,
      {} as never,
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      responseText: string;
      model: string;
      aiDurationMs: string;
      totalDurationMs: string;
    };
    assert.equal(body.responseText, "Short answer.");
    assert.equal(aiHarness.completeCalls.length, 1);
    assert.equal(aiHarness.completeCalls[0].messages.at(-1)?.content, "[jack] anyone know how queues work");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stream chat RPC streams model deltas and a final chunk", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authGatewayFetch as never;

  try {
    const aiHarness = createAigatewayEnv({
      stream: () => ({
        deltas: ["Hel", "lo"],
        final: { content: "Hello", model: "workers-ai/@cf/meta/llama-3.1-8b-instruct" },
      }),
    });
    const env = stsEnv({
      DB: createDbMock({}),
      ...aiHarness.env,
    });
    const response = await worker.fetch(
      streamingRpcRequest(
        "/ragbot.v1.ChatService/StreamChat",
        { prompt: "stream this please" },
        await signToken(),
      ),
      env,
      {} as never,
    );

    assert.equal(response.status, 200);
    const chunks = await readConnectStream(response);
    assert.deepEqual(
      chunks.filter((chunk) => !chunk.done).map((chunk) => chunk.delta),
      ["Hel", "lo"],
    );
    assert.equal(chunks.at(-1)?.done, true);
    assert.equal(chunks.at(-1)?.responseText, "Hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway start RPC requires STS auth and forwards to the durable object", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authGatewayFetch as never;
  let doFetchCalls = 0;

  try {
    const env = stsEnv({
      DB: createDbMock({}),
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
      rpcRequest("/ragbot.v1.GatewayControlService/StartGateway", {}),
      env,
      {} as never,
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(doFetchCalls, 0);

    const authorized = await worker.fetch(
      rpcRequest("/ragbot.v1.GatewayControlService/StartGateway", {}, await signToken()),
      env,
      {} as never,
    );
    assert.equal(authorized.status, 200);
    assert.equal(doFetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin RPCs enforce per-method scopes from the token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authGatewayFetch as never;

  try {
    const env = stsEnv({ DB: createDbMock({}) });
    const narrowToken = await signToken({ scope: "ragbot/ConfigService.ListConfig" });

    const allowed = await worker.fetch(
      rpcRequest("/ragbot.v1.ConfigService/ListConfig", {}, narrowToken),
      env,
      {} as never,
    );
    assert.equal(allowed.status, 200);

    const denied = await worker.fetch(
      rpcRequest(
        "/ragbot.v1.ConfigService/UpdateConfig",
        { key: "ai_temperature", value: "0.5" },
        narrowToken,
      ),
      env,
      {} as never,
    );
    assert.equal(denied.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("config update RPC writes the setting and reports the new entry", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authGatewayFetch as never;

  try {
    const env = stsEnv({
      DB: createDbMock({ settings: [{ key: "ai_temperature", value: "0.5" }] }),
    });
    const response = await worker.fetch(
      rpcRequest(
        "/ragbot.v1.ConfigService/UpdateConfig",
        { key: "ai_temperature", value: "0.5" },
        await signToken(),
      ),
      env,
      {} as never,
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      entry: { key: string; value: string; overridden?: boolean };
    };
    assert.equal(body.entry.key, "ai_temperature");
    assert.equal(body.entry.value, "0.5");

    const unknownKey = await worker.fetch(
      rpcRequest(
        "/ragbot.v1.ConfigService/UpdateConfig",
        { key: "not_a_key", value: "x" },
        await signToken(),
      ),
      env,
      {} as never,
    );
    assert.equal(unknownKey.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
