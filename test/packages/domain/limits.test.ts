import { assert, test } from "vitest";
import nacl from "tweetnacl";

import worker from "../../../workers/public/gateway/src/index.ts";
import { checkAiUsageAllowed } from "../../../packages/domain/limits.ts";
import { resolveGatewayMessage } from "../../../packages/domain/mention.ts";
import { decodeReplyJobEnvelope } from "../../../packages/contracts/index.ts";
import { createEnv, createSignedRequest } from "../../helpers.ts";

const BOT_USER_ID = "100000000000000001";
const GUILD_ID = "100000000000000002";
const CHANNEL_ID = "200000000000000001";
const THREAD_ID = "200000000000000002";
const MESSAGE_ID = "300000000000000001";
const ALICE_ID = "400000000000000001";
const BOB_ID = "400000000000000002";

const BURST_DENIAL_MESSAGE = "Slow down a little — try again in a minute.";
const BUDGET_DENIAL_MESSAGE = "The server's daily AI budget is spent. Try again tomorrow.";

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
  preparedSql?: string[];
} = {}) => ({
  batch: async () => {},
  prepare: (sql: string) => {
    options.preparedSql?.push(sql);
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

test("checkAiUsageAllowed denies once the trailing-minute burst count reaches the default limit", async () => {
  const insertedRequests: Array<{ sql: string; args: unknown[] }> = [];
  const preparedSql: string[] = [];
  const env = { DB: createLimitsDbMock({ requestCount: 8, insertedRequests, preparedSql }) } as never;

  const decision = await checkAiUsageAllowed(env, "1", "ask");

  assert.deepEqual(decision, {
    allowed: false,
    reason: "rate_limited",
    message: BURST_DENIAL_MESSAGE,
  });
  assert.equal(insertedRequests.length, 0);
  assert.isTrue(preparedSql.some((sql) => sql.includes("'-1 minute'")));
});

test("checkAiUsageAllowed denies once trailing 24h global spend reaches the default budget", async () => {
  const insertedRequests: Array<{ sql: string; args: unknown[] }> = [];
  const preparedSql: string[] = [];
  const env = { DB: createLimitsDbMock({ spendMicros: 10_000_000, insertedRequests, preparedSql }) } as never;

  const decision = await checkAiUsageAllowed(env, "1", "bicture");

  assert.deepEqual(decision, {
    allowed: false,
    reason: "budget_exceeded",
    message: BUDGET_DENIAL_MESSAGE,
  });
  assert.equal(insertedRequests.length, 0);
  const spendSql = preparedSql.find((sql) => sql.includes("SUM(estimated_cost_micros)"));
  assert.isDefined(spendSql);
  assert.isFalse(spendSql?.includes("requester_user_id"), "the global budget must not filter by user");
});

test("checkAiUsageAllowed honours env overrides and falls back on unparseable values", async () => {
  const burstLimited = await checkAiUsageAllowed(
    { DB: createLimitsDbMock({ requestCount: 3 }), AI_BURST_LIMIT_PER_MINUTE: "3" } as never,
    "1",
    "ask",
  );
  assert.equal(burstLimited.allowed, false);

  const underBudget = await checkAiUsageAllowed(
    { DB: createLimitsDbMock({ spendMicros: 24_000_000 }), AI_GLOBAL_DAILY_BUDGET_USD: "25.00" } as never,
    "1",
    "ask",
  );
  assert.deepEqual(underBudget, { allowed: true });

  const fallbackLimit = await checkAiUsageAllowed(
    { DB: createLimitsDbMock({ requestCount: 8 }), AI_BURST_LIMIT_PER_MINUTE: "not-a-number" } as never,
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

test("/ask replies immediately without deferring when the requester is burst limited", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createLimitsDbMock({ requestCount: 8 }),
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
      content: BURST_DENIAL_MESSAGE,
      allowed_mentions: { parse: [] },
    },
  });
});

test("/bicture replies immediately without deferring when the global daily budget is spent", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createLimitsDbMock({ spendMicros: 10_000_000 }),
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
      content: BUDGET_DENIAL_MESSAGE,
      allowed_mentions: { parse: [] },
    },
  });
});

test("/ragjam does not enqueue a job when the requester is burst limited", async () => {
  const keyPair = nacl.sign.keyPair();
  const enqueuedJobs: unknown[] = [];
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createLimitsDbMock({ requestCount: 8 }),
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
      content: BURST_DENIAL_MESSAGE,
      allowed_mentions: { parse: [] },
    },
  });
  assert.deepEqual(enqueuedJobs, []);
});

test("gateway mention resolution sends a burst limit notice through the outbox", async () => {
  const outboxJobs: Uint8Array[] = [];
  const env = createEnv("unused", {
    DB: createLimitsDbMock({ requestCount: 8 }),
    DISCORD_OUTBOX: {
      send: async (body: Uint8Array) => {
        outboxJobs.push(body);
      },
    },
  });

  const job = await resolveGatewayMessage(
    {
      kind: "message.received",
      messageId: MESSAGE_ID,
      channelId: CHANNEL_ID,
      botUserId: BOT_USER_ID,
      authorId: ALICE_ID,
      authorUsername: "alice",
      content: `<@${BOT_USER_ID}> Explain queues`,
      mentionUserIds: [BOT_USER_ID],
      mentionRoleIds: [],
    },
    env,
  );

  assert.equal(job, null);
  assert.equal(outboxJobs.length, 1);
  assert.deepEqual(decodeReplyJobEnvelope(outboxJobs[0]), {
    kind: "reply.channel_message",
    channelId: CHANNEL_ID,
    content: BURST_DENIAL_MESSAGE,
  });
});

test("tracked thread reply resolution sends a global budget notice through the outbox", async () => {
  const outboxJobs: Uint8Array[] = [];
  const env = createEnv("unused", {
    DB: createLimitsDbMock({
      spendMicros: 10_000_000,
      aiThread: {
        thread_id: THREAD_ID,
        parent_channel_id: CHANNEL_ID,
        source_message_id: MESSAGE_ID,
        requester_user_id: ALICE_ID,
        requester_username: "alice",
        initial_prompt: "Explain queues",
        title: "Queue chat",
      },
    }),
    DISCORD_OUTBOX: {
      send: async (body: Uint8Array) => {
        outboxJobs.push(body);
      },
    },
  });

  const job = await resolveGatewayMessage(
    {
      kind: "message.received",
      messageId: MESSAGE_ID,
      channelId: THREAD_ID,
      guildId: GUILD_ID,
      botUserId: BOT_USER_ID,
      authorId: BOB_ID,
      authorUsername: "bob",
      content: "what about dead letter queues?",
      mentionUserIds: [],
      mentionRoleIds: [],
    },
    env,
  );

  assert.equal(job, null);
  assert.equal(outboxJobs.length, 1);
  assert.deepEqual(decodeReplyJobEnvelope(outboxJobs[0]), {
    kind: "reply.channel_message",
    channelId: THREAD_ID,
    content: BUDGET_DENIAL_MESSAGE,
  });
});
