import { assert, test } from "vitest";
import nacl from "tweetnacl";

import worker, { handleGatewayMessageCreate } from "../src/index.ts";
import { checkAiUsageAllowed } from "../src/limits.ts";
import { createEnv, createSignedRequest } from "./helpers.ts";

const createLimitsDbMock = (options: {
  requestCount?: number;
  spendMicros?: number;
  aiThread?: {
    thread_id: string;
    parent_channel_id?: string | null;
    source_message_id?: string | null;
    requester_user_id?: string | null;
    requester_username?: string | null;
    initial_prompt: string;
    title: string;
  } | null;
  insertedRequests?: Array<{ sql: string; args: unknown[] }>;
} = {}) => ({
  batch: async () => {},
  prepare: (sql: string) => {
    const runner = (args: unknown[]) => ({
      sql,
      args,
      run: async () => {
        if (sql.includes("INSERT INTO rag_ai_requests")) {
          options.insertedRequests?.push({ sql, args });
        }
        return { results: undefined };
      },
      first: async () => {
        if (sql.includes("FROM rag_ai_requests")) {
          return { request_count: options.requestCount ?? 0 };
        }
        if (sql.includes("SUM(estimated_cost_micros)")) {
          return { spend_micros: options.spendMicros ?? 0 };
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

test("checkAiUsageAllowed records the request and allows usage under the limits", async () => {
  const insertedRequests: Array<{ sql: string; args: unknown[] }> = [];
  const env = { DB: createLimitsDbMock({ requestCount: 0, spendMicros: 0, insertedRequests }) } as never;

  const decision = await checkAiUsageAllowed(env, "1", "ask");

  assert.deepEqual(decision, { allowed: true });
  assert.equal(insertedRequests.length, 1);
  assert.deepEqual(insertedRequests[0].args, ["1", "ask"]);
});

test("checkAiUsageAllowed denies once the trailing-hour request count reaches the default limit", async () => {
  const insertedRequests: Array<{ sql: string; args: unknown[] }> = [];
  const env = { DB: createLimitsDbMock({ requestCount: 20, insertedRequests }) } as never;

  const decision = await checkAiUsageAllowed(env, "1", "ask");

  assert.deepEqual(decision, {
    allowed: false,
    reason: "rate_limited",
    message: "You've hit the hourly AI limit. Try again later.",
  });
  assert.equal(insertedRequests.length, 0);
});

test("checkAiUsageAllowed denies once trailing 24h spend reaches the default daily budget", async () => {
  const insertedRequests: Array<{ sql: string; args: unknown[] }> = [];
  const env = { DB: createLimitsDbMock({ spendMicros: 1_000_000, insertedRequests }) } as never;

  const decision = await checkAiUsageAllowed(env, "1", "bicture");

  assert.deepEqual(decision, {
    allowed: false,
    reason: "budget_exceeded",
    message: "You've spent your daily AI budget. Try again tomorrow.",
  });
  assert.equal(insertedRequests.length, 0);
});

test("checkAiUsageAllowed honours env overrides and falls back on unparseable values", async () => {
  const rateLimited = await checkAiUsageAllowed(
    { DB: createLimitsDbMock({ requestCount: 5 }), AI_RATE_LIMIT_PER_HOUR: "5" } as never,
    "1",
    "ask",
  );
  assert.equal(rateLimited.allowed, false);

  const underBudget = await checkAiUsageAllowed(
    { DB: createLimitsDbMock({ spendMicros: 2_400_000 }), AI_DAILY_BUDGET_USD: "2.50" } as never,
    "1",
    "ask",
  );
  assert.deepEqual(underBudget, { allowed: true });

  const fallbackLimit = await checkAiUsageAllowed(
    { DB: createLimitsDbMock({ requestCount: 20 }), AI_RATE_LIMIT_PER_HOUR: "not-a-number" } as never,
    "1",
    "ask",
  );
  assert.equal(fallbackLimit.allowed, false);
});

test("checkAiUsageAllowed fails open when D1 errors", async () => {
  const env = {
    DB: {
      prepare: () => {
        throw new Error("d1 unavailable");
      },
    },
  } as never;

  assert.deepEqual(await checkAiUsageAllowed(env, "1", "ask"), { allowed: true });
});

test("checkAiUsageAllowed allows requests without a user id and never touches D1", async () => {
  let prepareCalls = 0;
  const env = {
    DB: {
      prepare: () => {
        prepareCalls += 1;
        throw new Error("DB should not be used in this test");
      },
    },
  } as never;

  assert.deepEqual(await checkAiUsageAllowed(env, undefined, "ask"), { allowed: true });
  assert.equal(prepareCalls, 0);
});

test("/ask replies immediately without deferring when the requester is rate limited", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createLimitsDbMock({ requestCount: 20 }),
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

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "You've hit the hourly AI limit. Try again later.",
      allowed_mentions: { parse: [] },
    },
  });
});

test("/bicture replies immediately without deferring when the daily budget is spent", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createLimitsDbMock({ spendMicros: 1_000_000 }),
  });
  const request = createSignedRequest(
    {
      application_id: "application-id",
      token: "interaction-token",
      type: 2,
      data: {
        name: "bicture",
        options: [{ name: "prompt", value: "a tiny jpeg test image" }],
      },
      user: { id: "1", username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "You've spent your daily AI budget. Try again tomorrow.",
      allowed_mentions: { parse: [] },
    },
  });
});

test("/ragjam does not enqueue a job when the requester is rate limited", async () => {
  const keyPair = nacl.sign.keyPair();
  const enqueuedJobs: unknown[] = [];
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createLimitsDbMock({ requestCount: 20 }),
    AI_JOBS: {
      send: async (job: unknown) => {
        enqueuedJobs.push(job);
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
        name: "ragjam",
        options: [{ name: "prompt", value: "A warm acoustic folk ballad" }],
      },
      user: { id: "1", username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "You've hit the hourly AI limit. Try again later.",
      allowed_mentions: { parse: [] },
    },
  });
  assert.deepEqual(enqueuedJobs, []);
});

test("gateway mention posts a rate limit notice instead of enqueueing", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const queuedJobs: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DB: createLimitsDbMock({ requestCount: 20 }),
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

    assert.deepEqual(queuedJobs, []);
    const noticeCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/channel-id/messages",
    );
    assert.ok(noticeCall);
    assert.deepEqual(JSON.parse(String(noticeCall.init?.body)), {
      content: "You've hit the hourly AI limit. Try again later.",
      allowed_mentions: { parse: [] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tracked thread reply posts a budget notice instead of enqueueing", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const queuedJobs: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      DB: createLimitsDbMock({
        spendMicros: 1_000_000,
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
        author: { id: "2", username: "bob" },
      },
      env,
      "bot-user-id",
    );

    assert.deepEqual(queuedJobs, []);
    const noticeCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(noticeCall);
    assert.deepEqual(JSON.parse(String(noticeCall.init?.body)), {
      content: "You've spent your daily AI budget. Try again tomorrow.",
      allowed_mentions: { parse: [] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
