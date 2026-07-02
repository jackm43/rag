import { assert, test } from "vitest";
import nacl from "tweetnacl";

import worker from "../workers/public/gateway/src/index.ts";
import { encodeAiSpendJobEnvelope } from "../packages/contracts/index.ts";
import { processSpendQueueMessage } from "../packages/ai/spend.ts";
import { createDbMock, createEnv, createSignedRequest } from "./helpers.ts";

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

test("/rag is blocked while the invoker has an active raghammer ban", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DB: createDbMock({ ragBan: { expires_at: "2099-01-01T00:00:00.000Z" } }),
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

    const editCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.ok(editCall);
    assert.deepEqual(JSON.parse(String(editCall.init?.body)), {
      content: "You cannot use /rag until <t:4070908800:R>.",
      allowed_mentions: { parse: [] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/raghammer rejects non-admin invokers", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest(
    {
      type: 2,
      data: {
        name: "raghammer",
        options: [
          { name: "user", value: "2" },
          { name: "timeframe", value: "5m" },
        ],
      },
      member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "You are not allowed to use /raghammer.",
      allowed_mentions: { parse: [] },
    },
  });
});

test("/raghammer records a temporary /rag ban for admin invokers", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-06-28T00:00:00.000Z");
  const preparedStatements: Array<{ sql: string; args: unknown[] }> = [];

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DB: {
        batch: () => {
          throw new Error("batch should not be used in this test");
        },
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              preparedStatements.push({ sql, args });
              return { results: undefined };
            },
            first: async () => null,
            all: async () => ({ results: [], meta: {} }),
          }),
          run: async () => ({ results: undefined }),
          first: async () => null,
          all: async () => ({ results: [], meta: {} }),
        }),
      },
    });
    const request = createSignedRequest(
      {
        type: 2,
        data: {
          name: "raghammer",
          options: [
            { name: "user", value: "2" },
            { name: "timeframe", value: "1h" },
          ],
          resolved: {
            users: { "2": { id: "2", username: "bob", global_name: "Bob" } },
          },
        },
        member: {
          nick: "Admin",
          user: {
            id: "107426926909517824",
            username: "admin",
            global_name: "Admin",
          },
        },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {} as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: {
        content: "<@2> cannot use /rag for 1h.",
        allowed_mentions: {
          parse: [],
          users: ["2"],
        },
      },
    });
    assert.equal(preparedStatements.length, 1);
    assert.deepEqual(preparedStatements[0].args, [
      "2",
      "bob",
      "107426926909517824",
      "admin",
      "2026-06-28T01:00:00.000Z",
    ]);
  } finally {
    Date.now = originalNow;
  }
});

test("/ragunban rejects non-admin invokers", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest(
    {
      type: 2,
      data: {
        name: "ragunban",
        options: [{ name: "user", value: "2" }],
      },
      member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "You are not allowed to use /ragunban.",
      allowed_mentions: { parse: [] },
    },
  });
});

test("/ragunban removes active rag bans for admin invokers", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-06-28T00:00:00.000Z");
  const preparedStatements: Array<{ sql: string; args: unknown[] }> = [];

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DB: {
        batch: () => {
          throw new Error("batch should not be used in this test");
        },
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              preparedStatements.push({ sql, args });
              return { meta: { changes: 2 } };
            },
            first: async () => null,
            all: async () => ({ results: [], meta: {} }),
          }),
          run: async () => ({ meta: { changes: 0 } }),
          first: async () => null,
          all: async () => ({ results: [], meta: {} }),
        }),
      },
    });
    const request = createSignedRequest(
      {
        type: 2,
        data: {
          name: "ragunban",
          options: [{ name: "user", value: "2" }],
        },
        member: {
          nick: "Admin",
          user: {
            id: "114128631474683907",
            username: "admin",
            global_name: "Admin",
          },
        },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {} as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: {
        content: "<@2> can use /rag again.",
        allowed_mentions: {
          parse: [],
          users: ["2"],
        },
      },
    });
    assert.equal(preparedStatements.length, 1);
    assert.deepEqual(preparedStatements[0].args, ["2", "2026-06-28T00:00:00.000Z"]);
  } finally {
    Date.now = originalNow;
  }
});

test("/ragunban reports when there is no active rag ban", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: {
      batch: () => {
        throw new Error("batch should not be used in this test");
      },
      prepare: () => ({
        bind: () => ({
          run: async () => ({ meta: { changes: 0 } }),
          first: async () => null,
          all: async () => ({ results: [], meta: {} }),
        }),
        run: async () => ({ meta: { changes: 0 } }),
        first: async () => null,
        all: async () => ({ results: [], meta: {} }),
      }),
    },
  });
  const request = createSignedRequest(
    {
      type: 2,
      data: {
        name: "ragunban",
        options: [{ name: "user", value: "2" }],
      },
      member: {
        nick: "Admin",
        user: {
          id: "107426926909517824",
          username: "admin",
          global_name: "Admin",
        },
      },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "<@2> does not have an active /rag ban.",
      allowed_mentions: {
        parse: [],
        users: ["2"],
      },
    },
  });
});

test("/undorag rejects non-admin invokers", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest(
    {
      type: 2,
      data: {
        name: "undorag",
        options: [{ name: "user", value: "2" }],
      },
      member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "You are not allowed to use /undorag.",
      allowed_mentions: { parse: [] },
    },
  });
});

test("/undorag removes the latest rag event and decrements the target total", async () => {
  const keyPair = nacl.sign.keyPair();
  const batchStatements: Array<{ sql: string; args: unknown[] }> = [];
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createDbMock({
      latestRagEventId: 123,
      ragCount: 6,
      onBatch: (statements) => {
        batchStatements.push(...statements);
      },
    }),
  });
  const request = createSignedRequest(
    {
      type: 2,
      data: {
        name: "undorag",
        options: [{ name: "user", value: "2" }],
      },
      member: {
        nick: "Admin",
        user: {
          id: "116163000339136518",
          username: "admin",
          global_name: "Admin",
        },
      },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "Undid the last rag for <@2>. Total: 6",
      allowed_mentions: {
        parse: [],
        users: ["2"],
      },
    },
  });
  assert.equal(batchStatements.length, 2);
  assert.deepEqual(batchStatements[0].args, [123]);
  assert.deepEqual(batchStatements[1].args, ["2"]);
});

test("/undorag reports when the target has no rags to undo", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createDbMock({ latestRagEventId: null }),
  });
  const request = createSignedRequest(
    {
      type: 2,
      data: {
        name: "undorag",
        options: [{ name: "user", value: "2" }],
      },
      member: {
        nick: "Admin",
        user: {
          id: "102637456385392640",
          username: "admin",
          global_name: "Admin",
        },
      },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "<@2> has no rags to undo.",
      allowed_mentions: {
        parse: [],
        users: ["2"],
      },
    },
  });
});

test("/ragspend returns the invoker's precomputed spend", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => ({ results: [] }),
          first: async () => {
            assert.match(sql, /FROM rag_ai_spend_totals/);
            assert.deepEqual(args, ["user-id"]);
            return {
              requester_user_id: "user-id",
              requester_username: "Alice",
              estimated_cost_micros: 1234567,
              event_count: 4,
            };
          },
        }),
        run: async () => ({ results: [] }),
        first: async () => null,
      }),
    },
  });

  const response = await worker.fetch(
    createSignedRequest(
      {
        type: 2,
        data: { name: "ragspend" },
        member: { nick: "Alice", user: { id: "user-id", username: "alice" } },
      },
      keyPair.secretKey,
    ),
    env,
    {} as never,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "<@user-id> has spent $1.23",
      allowed_mentions: { parse: [] },
    },
  });
});

test("/ragspendboard returns the precomputed spend leaderboard", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: {
      prepare: (sql: string) => ({
        bind: () => {
          throw new Error("bind should not be used");
        },
        run: async () => {
          assert.match(sql, /FROM rag_ai_spend_totals/);
          return {
            results: [
              {
                requester_user_id: "2",
                requester_username: "Bob",
                estimated_cost_micros: 2500000,
                event_count: 2,
              },
              {
                requester_user_id: "1",
                requester_username: "Alice",
                estimated_cost_micros: 10000,
                event_count: 1,
              },
            ],
          };
        },
      }),
    },
  });

  const response = await worker.fetch(
    createSignedRequest({ type: 2, data: { name: "ragspendboard" } }, keyPair.secretKey),
    env,
    {} as never,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "Ragspendboard\n1. Bob - $2.50\n2. Alice - $0.01",
      allowed_mentions: { parse: [] },
    },
  });
});

test("spend worker aggregates pending spend events", async () => {
  const originalFetch = globalThis.fetch;
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /ai-gateway\/gateways\/platy\/logs/);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer cf-token");
    return Response.json({
      result: [
        {
          metadata: JSON.stringify({ ragbot_request_id: "event-1" }),
          cost: 0.033,
        },
      ],
    });
  };
  try {
    const env = createEnv("unused", {
      CF_ACCOUNT_ID: "account-id",
      CLOUDFLARE_API_TOKEN: "cf-token",
      CF_AIG_GATEWAY_ID: "platy",
      DB: {
        batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
          updates.push(...statements);
        },
        prepare: (sql: string) => {
          const runner = (args: unknown[]) => ({
            sql,
            args,
            first: async () => {
              assert.match(sql, /FROM rag_ai_spend_events/);
              assert.deepEqual(args, ["event-1"]);
              return {
                source_id: "event-1",
                kind: "ask",
                requester_user_id: "user-id",
                requester_username: "Alice",
                model: "grok/grok-4.3",
                prompt_tokens: 1000,
                completion_tokens: 2000,
                total_tokens: 3000,
                unit_count: 0,
                estimated_cost_micros: null,
                status: "pending",
              };
            },
            run: async () => ({ results: [] }),
          });
          return {
            ...runner([]),
            bind: (...args: unknown[]) => runner(args),
          };
        },
      },
    });
    let acked = false;

    await processSpendQueueMessage(
      {
        body: encodeAiSpendJobEnvelope({ spendEventId: "event-1" }, { source: "worker" }),
        attempts: 1,
        ack: () => {
          acked = true;
        },
        retry: () => {
          throw new Error("message should not be retried");
        },
      } as never,
      env,
    );

    assert.equal(acked, true);
    assert.equal(updates.length, 2);
    assert.match(updates[0].sql, /UPDATE rag_ai_spend_events/);
    assert.deepEqual(updates[0].args, [33000, "event-1"]);
    assert.match(updates[1].sql, /INSERT INTO rag_ai_spend_totals/);
    assert.match(updates[1].sql, /SUM\(estimated_cost_micros\)/);
    assert.deepEqual(updates[1].args, ["Alice", "user-id"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
