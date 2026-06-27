import { assert, test } from "vitest";
import nacl from "tweetnacl";
import { env as testEnv } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import worker, {
  DiscordGateway,
  extractBotMentionPrompt,
  handleGatewayMessageCreate,
} from "../src/index.ts";
import { shouldUseAskWebSearch } from "../src/commands/ask.ts";
import { fetchChannelMessages } from "../src/discord.ts";
import { bearerTokenMatches, secretsMatch } from "../src/http.ts";

const encoder = new TextEncoder();

const createSignedRequest = (
  payload: unknown,
  secretKey: Uint8Array,
  path = "/discord",
  timestamp = String(Math.floor(Date.now() / 1000)),
  authorization: string | null = "Bearer bot-token",
) => {
  const rawBody = JSON.stringify(payload);
  const message = encoder.encode(timestamp + rawBody);
  const signature = nacl.sign.detached(message, secretKey);
  const signatureHex = Buffer.from(signature).toString("hex");

  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === null ? {} : { authorization }),
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
    DISCORD_BOT_TOKEN: "bot-token",
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
  ragCount?: number;
  reportCount?: number;
  aiThread?: {
    thread_id: string;
    parent_channel_id?: string | null;
    source_message_id?: string | null;
    requester_user_id?: string | null;
    requester_username?: string | null;
    initial_prompt: string;
    title: string;
  } | null;
  onBatch?: (statements: Array<{ sql: string; args: unknown[] }>) => void;
} = {}) => ({
  batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
    options.onBatch?.(statements);
  },
  prepare: (sql: string) => {
    const runner = (args: unknown[]) => ({
      sql,
      args,
      run: async () => {
        return { results: undefined };
      },
      first: async () => {
        if (sql.includes("SELECT rag_count")) {
          return { rag_count: options.ragCount ?? 1 };
        }
        if (sql.includes("SELECT COUNT")) {
          return { report_count: options.reportCount ?? 1 };
        }
        if (sql.includes("FROM rag_ai_threads")) {
          return options.aiThread ?? null;
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

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});

test("old root interaction route returns 404", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey, "/");

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});

test("non-POST methods on the interaction route return 405", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = new Request("https://example.com/discord", { method: "PUT" });

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
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

test("stale Discord interaction timestamps return 401", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey, "/discord", staleTimestamp);

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("future Discord interaction timestamps return 401", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const futureTimestamp = String(Math.floor(Date.now() / 1000) + 301);
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey, "/discord", futureTimestamp);

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("non-numeric Discord interaction timestamps return 401", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey, "/discord", "not-a-time");

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("signed malformed Discord interaction returns 401", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ token: "interaction-token" }, keyPair.secretKey);

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("missing Discord signature headers return 401", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const response = await worker.fetch(
    new Request("https://example.com/discord", {
      method: "POST",
      headers: { authorization: "Bearer bot-token", "content-type": "application/json" },
      body: JSON.stringify({ type: 1 }),
    }),
    env,
    {} as never,
  );

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("bare Discord interaction POST returns 401", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = new Request("https://example.com/discord", { method: "POST" });

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("missing Discord authorization header returns 401", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey, "/discord", undefined, null);

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("malformed Discord authorization header returns 401", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey, "/discord", undefined, "Bot bot-token");

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("wrong Discord authorization bearer token returns 401", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey, "/discord", undefined, "Bearer wrong-token");

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Bad request signature");
});

test("malformed signature header returns 401 without throwing", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = new Request("https://example.com/discord", {
    method: "POST",
    headers: {
      authorization: "Bearer bot-token",
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

test("/ask interaction is deferred, creates a titled thread, and posts the answer", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const aiResponses = ["Worker queue retries", "Queues retry failed jobs before the DLQ."];
  const insertedThreads: Array<{ sql: string; args: unknown[] }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: aiResponses.shift() ?? "Queues retry failed jobs before the DLQ." });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id") {
      return Response.json({ id: "channel-id", type: 0, name: "general" });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id/threads") {
      return Response.json({ id: "thread-id", type: 11, parent_id: "channel-id", name: "Worker queue retries" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const baseDb = createDbMock();
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: {
        ...baseDb,
        prepare: (sql: string) => {
          const base = createDbMock().prepare(sql);
          return {
            ...base,
            bind: (...args: unknown[]) => ({
              ...base.bind(...args),
              run: async () => {
                if (sql.includes("INSERT INTO rag_ai_threads")) {
                  insertedThreads.push({ sql, args });
                }
                return base.bind(...args).run();
              },
            }),
          };
        },
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        channel_id: "channel-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "ask",
          options: [{ name: "prompt", value: "How do queue retries work?" }],
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

    const threadCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/channel-id/threads",
    );
    assert.ok(threadCall);
    assert.deepEqual(JSON.parse(String(threadCall.init?.body)), {
      name: "Worker queue retries",
      type: 11,
      auto_archive_duration: 1440,
    });

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content: "Queues retry failed jobs before the DLQ.",
      allowed_mentions: {
        parse: [],
      },
    });

    const editCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.ok(editCall);
    assert.deepEqual(JSON.parse(String(editCall.init?.body)), {
      content: "Started <#thread-id>",
      allowed_mentions: {
        parse: [],
      },
    });
    assert.deepEqual(insertedThreads[0].args, [
      "thread-id",
      "channel-id",
      null,
      "1",
      "Alice",
      "How do queue retries work?",
      "Worker queue retries",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/ask web search heuristic detects current research requests", () => {
  assert.equal(
    shouldUseAskWebSearch("can you get me information on the best GPUs across nvidia and AMD currently?"),
    true,
  );
  assert.equal(shouldUseAskWebSearch("How do queue retries work?"), false);
  assert.equal(shouldUseAskWebSearch("What are the latest GPU prices?"), true);
});

test("/ask uses the web-search model for current research prompts", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const insertedThreads: Array<{ sql: string; args: unknown[] }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  let gatewayCalls = 0;

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      gatewayCalls += 1;
      if (gatewayCalls === 1) {
        return Response.json({ response: "Current GPU picks" });
      }
      return Response.json({
        model: "gpt-4o-search-preview-2025-03-11",
        choices: [
          {
            message: {
              content:
                "Based on current reviews, compare RTX 5090, RTX 5080, RX 9990 XTX, and RX 9980 XT by price, power, and workload.",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.com/gpu-roundup",
                    title: "GPU roundup",
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id") {
      return Response.json({ id: "channel-id", type: 0, name: "general" });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id/threads") {
      return Response.json({ id: "thread-id", type: 11, parent_id: "channel-id", name: "Current GPU picks" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const baseDb = createDbMock();
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: {
        ...baseDb,
        prepare: (sql: string) => {
          const base = createDbMock().prepare(sql);
          return {
            ...base,
            bind: (...args: unknown[]) => ({
              ...base.bind(...args),
              run: async () => {
                if (sql.includes("INSERT INTO rag_ai_threads")) {
                  insertedThreads.push({ sql, args });
                }
                return base.bind(...args).run();
              },
            }),
          };
        },
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        channel_id: "channel-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "ask",
          options: [
            {
              name: "prompt",
              value: "can you get me information on the best GPUs across nvidia and AMD currently?",
            },
          ],
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

    const webSearchCall = fetchCalls.filter((call) => call.url.includes("gateway.ai.cloudflare.com"))[1];
    assert.ok(webSearchCall);
    assert.equal(
      webSearchCall.url,
      "https://gateway.ai.cloudflare.com/v1/account-id/platy/compat/chat/completions",
    );
    assert.equal(
      (webSearchCall.init?.headers as Record<string, string>)["cf-aig-authorization"],
      "Bearer gateway-token",
    );
    const webSearchBody = JSON.parse(String(webSearchCall.init?.body));
    assert.equal(webSearchBody.model, "openai/gpt-4o-search-preview");
    assert.match(webSearchBody.messages[0].content, /careful web research assistant/);
    assert.match(webSearchBody.messages[1].content, /best GPUs across nvidia and AMD currently/);
    assert.equal(webSearchBody.max_tokens, 1200);
    assert.deepEqual(webSearchBody.web_search_options, { search_context_size: "medium" });

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content:
        "Based on current reviews, compare RTX 5090, RTX 5080, RX 9990 XTX, and RX 9980 XT by price, power, and workload.\n\nSources: https://example.com/gpu-roundup",
      allowed_mentions: {
        parse: [],
      },
    });
    assert.deepEqual(insertedThreads[0].args, [
      "thread-id",
      "channel-id",
      null,
      "1",
      "Alice",
      "can you get me information on the best GPUs across nvidia and AMD currently?",
      "Current GPU picks",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/ask reports AI response failures after creating the thread", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  let gatewayCalls = 0;

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      gatewayCalls += 1;
      if (gatewayCalls === 2) {
        return Response.json({ error: { message: "web search model unavailable" } }, { status: 500 });
      }
      return Response.json({ response: "Current GPU picks" });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id") {
      return Response.json({ id: "channel-id", type: 0, name: "general" });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id/threads") {
      return Response.json({ id: "thread-id", type: 11, parent_id: "channel-id", name: "Current GPU picks" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock(),
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        channel_id: "channel-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "ask",
          options: [{ name: "prompt", value: "What are the latest GPU prices?" }],
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

    const threadMessage = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(threadMessage);
    assert.deepEqual(JSON.parse(String(threadMessage.init?.body)), {
      content: "I started this thread, but the AI response failed. Try again in a moment.",
      allowed_mentions: {
        parse: [],
      },
    });

    const editCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.ok(editCall);
    assert.deepEqual(JSON.parse(String(editCall.init?.body)), {
      content: "Started <#thread-id>, but the AI response failed.",
      allowed_mentions: {
        parse: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
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
      DB: createDbMock({ ragCount: 7 }),
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

    const discordCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.ok(discordCall);
    assert.equal(
      discordCall.url,
      "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.equal(discordCall.init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(discordCall.init?.body)), {
      content: "<@2> just ragged. Total: 7",
      allowed_mentions: {
        parse: [],
        users: ["2"],
      },
    });
    assert.equal(fetchCalls.some((call) => call.url.includes("gateway.ai.cloudflare.com")), false);
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

test("gateway message create enqueues a channel reply AI job", async () => {
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
      member: { nick: "Tarkaus" },
    },
    env,
    "bot-user-id",
  );

  assert.deepEqual(queuedJobs, [
    {
      kind: "channel_reply",
      channelId: "channel-id",
      messageId: "message-id",
      botUserId: "bot-user-id",
      requesterUserId: "1",
      requesterUsername: "Tarkaus",
      prompt: "Explain queues",
      replyMessageId: undefined,
      replyChannelId: undefined,
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
      author: { id: "1", username: "alice", global_name: "Alice Display" },
    },
    env,
    "bot-user-id",
  );

  assert.deepEqual(queuedJobs, [
    {
      kind: "channel_reply",
      channelId: "channel-id",
      messageId: "message-id",
      botUserId: "bot-user-id",
      requesterUserId: "1",
      requesterUsername: "Alice Display",
      prompt: "hey",
      replyMessageId: undefined,
      replyChannelId: undefined,
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
        kind: "channel_reply",
        channelId: "channel-id",
        messageId: "message-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "alice",
        prompt: "whats up",
        replyMessageId: undefined,
        replyChannelId: undefined,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway message create enqueues only replied-to message metadata", async () => {
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
      kind: "channel_reply",
      channelId: "channel-id",
      messageId: "message-id",
      botUserId: "bot-user-id",
      requesterUserId: "1",
      requesterUsername: "alice",
      prompt: "Summarize this",
      replyMessageId: "referenced-message-id",
      replyChannelId: "channel-id",
    },
  ]);
});

test("gateway message create does not fetch referenced message content", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const queuedJobs: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return Response.json({});
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

    assert.deepEqual(fetchCalls, []);
    assert.deepEqual(queuedJobs, [
      {
        kind: "channel_reply",
        channelId: "channel-id",
        messageId: "message-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "alice",
        prompt: "what does this say",
        replyMessageId: "referenced-message-id",
        replyChannelId: "referenced-channel-id",
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

test("gateway message create enqueues tracked thread replies without requiring a mention", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    DB: createDbMock({
      aiThread: {
        thread_id: "thread-id",
        parent_channel_id: "channel-id",
        source_message_id: "source-message-id",
        requester_user_id: "1",
        requester_username: "alice",
        initial_prompt: "Explain queues",
        title: "Queue chat",
      },
    }),
    AI_JOBS: {
      send: async (job: unknown) => {
        queuedJobs.push(job);
      },
    },
  });

  await handleGatewayMessageCreate(
    {
      id: "message-id",
      guild_id: "guild-id",
      channel_id: "thread-id",
      content: "what about dead letter queues?",
      author: { id: "2", username: "bob", global_name: "Bob Display" },
    },
    env,
    "bot-user-id",
  );

  assert.deepEqual(queuedJobs, [
    {
      kind: "thread_reply",
      channelId: "thread-id",
      messageId: "message-id",
      botUserId: "bot-user-id",
      requesterUserId: "2",
      requesterUsername: "Bob Display",
      prompt: "what about dead letter queues?",
      replyMessageId: undefined,
      replyChannelId: undefined,
    },
  ]);
});

test("fetchChannelMessages drops malformed Discord messages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json([
      {
        id: "message-id",
        channel_id: "channel-id",
        content: "hello",
        author: { id: "user-id", username: "alice" },
      },
      {
        id: "missing-channel-id",
        content: "bad",
      },
      "bad",
    ]);

  try {
    const env = createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" });
    const messages = await fetchChannelMessages(env, "channel-id");

    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, "message-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler acknowledges malformed AI jobs without side effects", async () => {
  let acked = false;
  const env = createEnv("unused");

  await worker.queue(
    {
      messages: [
        {
          body: { kind: "channel", channelId: "channel-id" },
          ack: () => {
            acked = true;
          },
        },
      ],
    } as never,
    env,
  );

  assert.equal(acked, true);
});

test("worker rejects /gateway/start without bot token auth", async () => {
  let startCalls = 0;
  const env = createEnv("unused", {
    DISCORD_BOT_TOKEN: "bot-token",
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
    {} as never,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal(startCalls, 0);

  const unauthorized = await worker.fetch(
    new Request("https://example.com/gateway/start", { method: "POST" }),
    env,
    {} as never,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(startCalls, 0);

  const authorized = await worker.fetch(
    new Request("https://example.com/gateway/start", {
      method: "POST",
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    {} as never,
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { ok: true });
  assert.equal(startCalls, 1);
});

test("worker rejects /gateway/health without bot token auth", async () => {
  let healthCalls = 0;
  const env = createEnv("unused", {
    DISCORD_BOT_TOKEN: "bot-token",
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
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    {} as never,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  assert.equal(healthCalls, 0);

  const unauthorized = await worker.fetch(
    new Request("https://example.com/gateway/health", { method: "GET" }),
    env,
    {} as never,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(healthCalls, 0);

  const authorized = await worker.fetch(
    new Request("https://example.com/gateway/health", {
      method: "GET",
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    {} as never,
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
    {} as never,
  );
  assert.equal(unknownGet.status, 404);

  const unknownPost = await worker.fetch(
    createSignedRequest({ type: 1 }, keyPair.secretKey, "/anything"),
    env,
    {} as never,
  );
  assert.equal(unknownPost.status, 404);

  const oauth = await worker.fetch(
    new Request("https://example.com/oauth/config", { method: "GET" }),
    env,
    {} as never,
  );
  assert.equal(oauth.status, 404);

  const admin = await worker.fetch(
    new Request("https://example.com/admin/config", {
      method: "GET",
      headers: { authorization: "Bearer anything" },
    }),
    env,
    {} as never,
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
      {} as never,
    );
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), "Not found", path);
  }

  const unknownGatewayWithoutAuth = await worker.fetch(
    new Request("https://example.com/gateway/unknown", { method: "POST" }),
    env,
    {} as never,
  );
  assert.equal(unknownGatewayWithoutAuth.status, 404);

  const unknownGateway = await worker.fetch(
    new Request("https://example.com/gateway/unknown", {
      method: "POST",
      headers: { authorization: "Bearer bot-token" },
    }),
    env,
    {} as never,
  );
  assert.equal(unknownGateway.status, 404);
  assert.equal(gatewayFetchCalls, 0);
});

test("gateway durable object start RPC persists enabled state and schedules an alarm", async () => {
  const originalWebSocket = globalThis.WebSocket;
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
    const id = testEnv.DISCORD_GATEWAY.idFromName(`rpc-test-${crypto.randomUUID()}`);
    const gateway = testEnv.DISCORD_GATEWAY.get(id);

    const initialHealth = await gateway.health();
    assert.deepEqual(initialHealth, { connected: false, resumable: false });

    const response = await gateway.start();
    assert.deepEqual(response, { ok: true });

    await runInDurableObject(gateway, async (_instance, state) => {
      assert.equal(await state.storage.get("gatewayEnabled"), true);
      const alarmTime = await state.storage.getAlarm();
      assert.equal(typeof alarmTime, "number");
      assert.ok((alarmTime ?? 0) > Date.now());
    });
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("queue handler posts channel reply jobs without creating a thread", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: "Short answer." });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock({}),
    });
    const ackedMessages: unknown[] = [];
    const message = {
      body: {
        kind: "channel_reply",
        channelId: "channel-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "metro goonin",
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

    assert.equal(fetchCalls.find((call) => call.url.includes("/threads")), undefined);
    assert.equal(fetchCalls.find((call) => call.url.includes("/messages?")), undefined);

    const gatewayCalls = fetchCalls.filter((call) => call.url.includes("gateway.ai.cloudflare.com"));
    assert.equal(gatewayCalls.length, 1);
    const input = JSON.parse(String(gatewayCalls[0].init?.body)) as { messages: Array<{ role: string; content: string }> };
    assert.deepEqual(input.messages.slice(1), [
      { role: "user", content: "metro goonin: and what about retries" },
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

test("queue handler treats a thread-start job as fresh, creates a thread, and posts there", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const insertedThreads: Array<{ sql: string; args: unknown[] }> = [];
  const aiResponses = ["Short answer.", "Queue retries"];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: aiResponses.shift() ?? "Queue retries" });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id/messages/trigger-id/threads") {
      return Response.json({ id: "thread-id", type: 11, parent_id: "channel-id", name: "Queue retries" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: {
        ...createDbMock({}),
        prepare: (sql: string) => {
          const base = createDbMock().prepare(sql);
          return {
            ...base,
            bind: (...args: unknown[]) => ({
              ...base.bind(...args),
              run: async () => {
                if (sql.includes("INSERT INTO rag_ai_threads")) {
                  insertedThreads.push({ sql, args });
                }
                return base.bind(...args).run();
              },
            }),
          };
        },
      },
    });
    const ackedMessages: unknown[] = [];
    const message = {
      body: {
        kind: "thread_start",
        channelId: "channel-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "metro goonin",
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
    assert.equal(historyCall, undefined);

    const gatewayCalls = fetchCalls.filter((call) => call.url.includes("gateway.ai.cloudflare.com"));
    assert.equal(gatewayCalls.length, 2);
    const input = JSON.parse(String(gatewayCalls[0].init?.body)) as { messages: Array<{ role: string; content: string }> };
    assert.match(input.messages[0].content, /Use only the provided thread conversation context/);
    assert.deepEqual(input.messages.slice(1), [
      { role: "user", content: "metro goonin: and what about retries" },
    ]);

    const titleInput = JSON.parse(String(gatewayCalls[1].init?.body)) as { messages: Array<{ role: string; content: string }> };
    assert.match(titleInput.messages[0].content, /thread title/);

    const threadCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/channel-id/messages/trigger-id/threads",
    );
    assert.ok(threadCall);
    assert.deepEqual(JSON.parse(String(threadCall.init?.body)), {
      name: "Queue retries",
      auto_archive_duration: 1440,
    });

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content: "Short answer.",
      allowed_mentions: {
        parse: [],
      },
    });
    assert.deepEqual(insertedThreads[0].args, [
      "thread-id",
      "channel-id",
      "trigger-id",
      "1",
      "metro goonin",
      "and what about retries",
      "Queue retries",
    ]);
    assert.deepEqual(ackedMessages, [message.body]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler builds a conversation from tracked thread history and posts the reply", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: "Short answer." });
    }
    if (String(url).includes("/messages?")) {
      // Discord returns newest-first.
      return Response.json([
        {
          id: "m3",
          channel_id: "thread-id",
          content: "anyone know how queues work",
          author: { id: "1", username: "._jak", global_name: "jak" },
        },
        {
          id: "m2",
          channel_id: "thread-id",
          content: "Queues deliver messages asynchronously.",
          author: { id: "bot-user-id", username: "ragbot", bot: true },
        },
        {
          id: "m1",
          channel_id: "thread-id",
          content: "<@999000000000000001> hello",
          author: { id: "2", username: "bob", global_name: "Bob Display" },
        },
      ]);
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock({
        aiThread: {
          thread_id: "thread-id",
          parent_channel_id: "channel-id",
          source_message_id: "source-message-id",
          requester_user_id: "1",
          requester_username: "metro goonin",
          initial_prompt: "Explain queues",
          title: "Queue retries",
        },
      }),
    });
    const ackedMessages: unknown[] = [];
    const message = {
      body: {
        kind: "thread_reply",
        channelId: "thread-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "metro goonin",
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
      "https://discord.com/api/v10/channels/thread-id/messages?before=trigger-id&limit=3",
    );

    const gatewayCall = fetchCalls.find((call) => call.url.includes("gateway.ai.cloudflare.com"));
    assert.ok(gatewayCall);
    const input = JSON.parse(String(gatewayCall.init?.body)) as { messages: Array<{ role: string; content: string }> };
    assert.equal(input.messages[0].role, "system");
    assert.deepEqual(input.messages.slice(1), [
      { role: "user", content: "metro goonin: Explain queues" },
      { role: "user", content: "Bob Display: hello" },
      { role: "assistant", content: "Queues deliver messages asynchronously." },
      { role: "user", content: "metro goonin: anyone know how queues work" },
      { role: "user", content: "metro goonin: and what about retries" },
    ]);

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
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

test("queue handler keeps non-search replies inside /ask thread mode", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: "The practical difference is delivery timing." });
    }
    if (String(url).includes("/messages?")) {
      return Response.json([
        {
          id: "m1",
          channel_id: "thread-id",
          content: "Queues deliver work later.",
          author: { id: "bot-user-id", username: "ragbot", bot: true },
        },
      ]);
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock({
        aiThread: {
          thread_id: "thread-id",
          parent_channel_id: "channel-id",
          source_message_id: null,
          requester_user_id: "1",
          requester_username: "Alice",
          initial_prompt: "Explain queues",
          title: "Queue explanation",
        },
      }),
    });
    const message = {
      body: {
        kind: "thread_reply",
        channelId: "thread-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "Alice",
        prompt: "how is that different from a cron trigger?",
      },
      ack: () => undefined,
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    const gatewayCall = fetchCalls.find((call) => call.url.includes("gateway.ai.cloudflare.com"));
    assert.ok(gatewayCall);
    const input = JSON.parse(String(gatewayCall.init?.body)) as { messages: Array<{ role: string; content: string }> };
    assert.match(input.messages[0].content, /This is a \/ask thread/);
    assert.equal(/normal chat reply/.test(input.messages[0].content), false);
    assert.deepEqual(input.messages.slice(1), [
      { role: "user", content: "Alice: Explain queues" },
      { role: "assistant", content: "Queues deliver work later." },
      { role: "user", content: "Alice: how is that different from a cron trigger?" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler uses web search for current follow-ups in /ask threads", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({
        model: "gpt-4o-search-preview-2025-03-11",
        choices: [
          {
            message: {
              content: "The current pick is ExampleDB based on recent pricing.",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.com/current-db-pricing",
                    title: "Current DB pricing",
                  },
                },
              ],
            },
          },
        ],
      });
    }
    if (String(url).includes("/messages?")) {
      return Response.json([
        {
          id: "m1",
          channel_id: "thread-id",
          content: "Earlier answer.",
          author: { id: "bot-user-id", username: "ragbot", bot: true },
        },
      ]);
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock({
        aiThread: {
          thread_id: "thread-id",
          parent_channel_id: "channel-id",
          source_message_id: null,
          requester_user_id: "1",
          requester_username: "Alice",
          initial_prompt: "Compare serverless databases",
          title: "Serverless databases",
        },
      }),
    });
    const message = {
      body: {
        kind: "thread_reply",
        channelId: "thread-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUserId: "1",
        requesterUsername: "Alice",
        prompt: "what is the latest pricing?",
      },
      ack: () => undefined,
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    const gatewayCall = fetchCalls.find((call) => call.url.includes("gateway.ai.cloudflare.com"));
    assert.ok(gatewayCall);
    const body = JSON.parse(String(gatewayCall.init?.body));
    assert.equal(body.model, "openai/gpt-4o-search-preview");
    assert.match(body.messages[0].content, /careful web research assistant/);
    assert.match(body.messages[1].content, /Thread conversation context/);
    assert.match(body.messages[1].content, /Compare serverless databases/);
    assert.match(body.messages[1].content, /what is the latest pricing/);
    assert.deepEqual(body.web_search_options, { search_context_size: "medium" });

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content:
        "The current pick is ExampleDB based on recent pricing.\n\nSources: https://example.com/current-db-pricing",
      allowed_mentions: {
        parse: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler excludes rag command bot output from thread history", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: "Normal chat reply." });
    }
    if (String(url).includes("/messages?")) {
      return Response.json([
        {
          id: "m2",
          channel_id: "thread-id",
          content: "<@2> has just ragged. Total: 32",
          author: { id: "bot-user-id", username: "ragbot", bot: true },
        },
        {
          id: "m1",
          channel_id: "thread-id",
          content: "who was in paris",
          author: { id: "1", username: "alice" },
        },
      ]);
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock({
        aiThread: {
          thread_id: "thread-id",
          parent_channel_id: "channel-id",
          source_message_id: "source-message-id",
          requester_user_id: "1",
          requester_username: "alice",
          initial_prompt: "who was in paris",
          title: "Paris question",
        },
      }),
    });
    const message = {
      body: {
        kind: "thread_reply",
        channelId: "thread-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUsername: "alice",
        prompt: "who was in paris",
      },
      ack: () => undefined,
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    const gatewayCall = fetchCalls.find((call) => call.url.includes("gateway.ai.cloudflare.com"));
    assert.ok(gatewayCall);
    const input = JSON.parse(String(gatewayCall.init?.body)) as { messages: Array<{ role: string; content: string }> };
    assert.match(input.messages[0].content, /normal chat reply, not the \/rag command/);
    assert.deepEqual(input.messages.slice(1), [
      { role: "user", content: "alice: who was in paris" },
      { role: "user", content: "alice: who was in paris" },
      { role: "user", content: "alice: who was in paris" },
    ]);
    assert.equal(JSON.stringify(input.messages.slice(1)).includes("has just ragged"), false);
    assert.equal(JSON.stringify(input.messages.slice(1)).includes("Total: 32"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler fetches replied-to context from Discord REST", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: "It says approved for launch." });
    }
    if (String(url).includes("/messages?")) {
      return Response.json([]);
    }
    if (String(url) === "https://discord.com/api/v10/channels/referenced-channel-id/messages/referenced-message-id") {
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
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock({}),
    });
    const message = {
      body: {
        kind: "thread_reply",
        channelId: "thread-id",
        messageId: "trigger-id",
        botUserId: "bot-user-id",
        requesterUsername: "alice",
        prompt: "what does this say",
        replyMessageId: "referenced-message-id",
        replyChannelId: "referenced-channel-id",
      },
      ack: () => undefined,
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    assert.ok(
      fetchCalls.find(
        (call) =>
          call.url === "https://discord.com/api/v10/channels/referenced-channel-id/messages/referenced-message-id",
      ),
    );
    const gatewayCall = fetchCalls.find((call) => call.url.includes("gateway.ai.cloudflare.com"));
    assert.ok(gatewayCall);
    const input = JSON.parse(String(gatewayCall.init?.body)) as { messages: Array<{ role: string; content: string }> };
    assert.deepEqual(input.messages.slice(1), [
      {
        role: "user",
        content:
          "Replied-to message from bob:\nThis label says approved for launch.\nAttachment: label.png (image/png) https://cdn.discordapp.com/attachments/label.png\n\nalice: what does this say",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler sanitizes mentions and IDs from the model output", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: "Hello <@123456789012345678> there 123456789012345678" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock({}),
    });
    const message = {
      body: {
        kind: "thread_reply",
        channelId: "thread-id",
        prompt: "Say hello",
      },
      ack: () => undefined,
      retry: () => {
        throw new Error("message should not be retried");
      },
    };

    await worker.queue({ messages: [message] } as never, env);

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content: "Hello there",
      allowed_mentions: {
        parse: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler uses the source-controlled partner model", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ choices: [{ message: { content: "grok response" } }] });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock(),
    });
    const message = {
      body: {
        kind: "thread_reply",
        channelId: "thread-id",
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
    const gatewayBody = JSON.parse(String(gatewayCall.init?.body));
    assert.equal(gatewayBody.model, "grok/grok-4.3");
    assert.equal(gatewayBody.max_tokens, 1000);
    assert.equal(gatewayBody.max_completion_tokens, undefined);

    const discordCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(discordCall);
    assert.deepEqual(JSON.parse(String(discordCall.init?.body)), {
      content: "grok response",
      allowed_mentions: {
        parse: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler records partner AI Gateway usage", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const insertedInteractions: Array<{ sql: string; args: unknown[] }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({
        model: "grok-4.3",
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
        kind: "thread_reply",
        channelId: "thread-id",
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
    const gatewayBody = JSON.parse(String(gatewayCall.init?.body));
    assert.equal(gatewayBody.model, "grok/grok-4.3");
    assert.equal(gatewayBody.messages[0].role, "system");
    assert.match(gatewayBody.messages[0].content, /normal chat reply, not the \/rag command/);
    assert.deepEqual(gatewayBody.messages.slice(1), [{ role: "user", content: "user: Say hello" }]);
    assert.equal(gatewayBody.max_tokens, 1000);
    assert.equal(gatewayBody.temperature, 0.9);

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
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
