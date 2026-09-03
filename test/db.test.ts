import { env } from "cloudflare:test";
import { assert, beforeEach, describe, test } from "vitest";

import { activeAiBanForUser, activeRagBanForUser, aiBanMessage } from "../src/lib/db/bans";
import { checkAiUsageAllowed, pruneAiRequestLog } from "../src/lib/db/limits";
import { findAiThread, recordAiThread } from "../src/lib/db/threads";
import { GUILD_NOT_ALLOWED_MESSAGE, isGuildAllowed } from "../src/lib/db/guilds";
import {
  buildNormalThreadConversation,
  fallbackThreadTitle,
  isAskThread,
  sanitizeThreadTitle,
} from "../src/lib/db/conversation";
import { createAiSpendSourceId, formatUsdMicros, recordAiSpendEvent } from "../src/lib/ai/spend";
import type { Env } from "../src/env";
import type { BotConfig } from "../src/lib/ai/config";

const DB = env.DB;
const dbEnv = { DB } as unknown as Env;

const ALICE_ID = "400000000000000001";
const BOB_ID = "400000000000000002";
const ALLOWED_GUILD_ID = "100000000000000002";
const OTHER_GUILD_ID = "100000000000000003";
const THREAD_ID = "200000000000000002";
const CHANNEL_ID = "200000000000000001";
const MESSAGE_ID = "300000000000000001";

const insertBan = (userId: string, expiresAt: string) =>
  DB.prepare(
    "INSERT INTO rag_command_bans (banned_user_id, banned_by_user_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(userId, "moderator", expiresAt)
    .run();

const throwingDbEnv = {
  DB: {
    prepare: () => {
      throw new Error("d1 unavailable");
    },
  },
} as unknown as Env;

// Storage is isolated per test file, not per test, so clear the mutated tables
// before each test to keep the row-count/budget assertions independent.
beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM rag_command_bans"),
    DB.prepare("DELETE FROM rag_ai_requests"),
    DB.prepare("DELETE FROM rag_ai_spend_events"),
    DB.prepare("DELETE FROM rag_ai_threads"),
  ]);
});

describe("bans", () => {
  test("aiBanMessage renders the expiry as a Discord relative timestamp", () => {
    const expiresAt = "2030-01-02T03:04:05.000Z";
    assert.equal(
      aiBanMessage(expiresAt),
      `You cannot use AI commands until <t:${Math.floor(Date.parse(expiresAt) / 1000)}:R>.`,
    );
    assert.equal(aiBanMessage("not-a-date"), "You cannot use AI commands until not-a-date.");
  });

  test("activeRagBanForUser returns an active ban and ignores expired ones", async () => {
    const now = new Date("2030-06-01T00:00:00.000Z");
    await insertBan(ALICE_ID, "2030-06-02T00:00:00.000Z");
    await insertBan(BOB_ID, "2030-05-01T00:00:00.000Z");

    const aliceBan = await activeRagBanForUser(dbEnv, ALICE_ID, now);
    assert.equal(aliceBan?.expires_at, "2030-06-02T00:00:00.000Z");

    const bobBan = await activeRagBanForUser(dbEnv, BOB_ID, now);
    assert.isNull(bobBan);
  });

  test("activeAiBanForUser fails open when D1 errors", async () => {
    assert.isNull(await activeAiBanForUser(throwingDbEnv, ALICE_ID, new Date()));
  });
});

describe("limits", () => {
  test("checkAiUsageAllowed records the request and allows usage under the limits", async () => {
    const decision = await checkAiUsageAllowed(dbEnv, ALICE_ID, "ask");
    assert.deepEqual(decision, { allowed: true });

    const row = await DB.prepare(
      "SELECT COUNT(*) AS c FROM rag_ai_requests WHERE requester_user_id = ? AND kind = ?",
    )
      .bind(ALICE_ID, "ask")
      .first<{ c: number }>();
    assert.equal(row?.c, 1);
  });

  test("checkAiUsageAllowed denies once the trailing-minute burst count reaches the limit", async () => {
    for (let i = 0; i < 8; i += 1) {
      await DB.prepare("INSERT INTO rag_ai_requests (requester_user_id, kind) VALUES (?, ?)")
        .bind(BOB_ID, "ask")
        .run();
    }

    const decision = await checkAiUsageAllowed(dbEnv, BOB_ID, "ask");
    assert.deepEqual(decision, {
      allowed: false,
      reason: "rate_limited",
      message: "Slow down a little — try again in a minute.",
    });
  });

  test("checkAiUsageAllowed denies once trailing-24h global spend reaches the budget", async () => {
    await DB.prepare(
      "INSERT INTO rag_ai_spend_events (source_id, kind, requester_user_id, model, estimated_cost_micros, status) VALUES (?, ?, ?, ?, ?, 'aggregated')",
    )
      .bind(createAiSpendSourceId(), "ask", ALICE_ID, "test/model", 10_000_000)
      .run();

    const decision = await checkAiUsageAllowed(dbEnv, ALICE_ID, "bicture");
    assert.deepEqual(decision, {
      allowed: false,
      reason: "budget_exceeded",
      message: "The server's daily AI budget is spent. Try again tomorrow.",
    });
  });

  test("checkAiUsageAllowed honours the AI_GLOBAL_DAILY_BUDGET_USD override", async () => {
    await DB.prepare(
      "INSERT INTO rag_ai_spend_events (source_id, kind, requester_user_id, model, estimated_cost_micros, status) VALUES (?, ?, ?, ?, ?, 'aggregated')",
    )
      .bind(createAiSpendSourceId(), "ask", ALICE_ID, "test/model", 24_000_000)
      .run();

    const underBudget = await checkAiUsageAllowed(
      { DB, AI_GLOBAL_DAILY_BUDGET_USD: "25.00" } as unknown as Env,
      ALICE_ID,
      "ask",
    );
    assert.deepEqual(underBudget, { allowed: true });

    const overBudget = await checkAiUsageAllowed(
      { DB, AI_GLOBAL_DAILY_BUDGET_USD: "20.00" } as unknown as Env,
      ALICE_ID,
      "ask",
    );
    assert.equal(overBudget.allowed, false);
  });

  test("pruneAiRequestLog drops request rows older than a day and keeps fresh ones", async () => {
    await DB.batch([
      DB.prepare("INSERT INTO rag_ai_requests (requester_user_id, kind, created_at) VALUES (?, 'ask', datetime('now', '-2 days'))").bind(ALICE_ID),
      DB.prepare("INSERT INTO rag_ai_requests (requester_user_id, kind) VALUES (?, 'ask')").bind(ALICE_ID),
    ]);

    await pruneAiRequestLog(dbEnv);

    const row = await DB.prepare("SELECT COUNT(*) AS c FROM rag_ai_requests WHERE requester_user_id = ?")
      .bind(ALICE_ID)
      .first<{ c: number }>();
    assert.equal(row?.c, 1);
    // Best-effort: a D1 failure is swallowed.
    await pruneAiRequestLog(throwingDbEnv);
  });

  test("checkAiUsageAllowed fails open when D1 errors", async () => {
    assert.deepEqual(await checkAiUsageAllowed(throwingDbEnv, ALICE_ID, "ask"), { allowed: true });
  });

  test("checkAiUsageAllowed allows requests without a user id and never touches D1", async () => {
    assert.deepEqual(await checkAiUsageAllowed(throwingDbEnv, undefined, "ask"), { allowed: true });
  });
});

describe("threads", () => {
  test("recordAiThread upserts and findAiThread reads it back", async () => {
    await recordAiThread(dbEnv, {
      threadId: THREAD_ID,
      parentChannelId: CHANNEL_ID,
      sourceMessageId: MESSAGE_ID,
      requesterUserId: ALICE_ID,
      requesterUsername: "alice",
      initialPrompt: "Explain queues",
      title: "Queue chat",
    });

    const stored = await findAiThread(dbEnv, THREAD_ID);
    assert.deepEqual(stored, {
      threadId: THREAD_ID,
      parentChannelId: CHANNEL_ID,
      sourceMessageId: MESSAGE_ID,
      requesterUserId: ALICE_ID,
      requesterUsername: "alice",
      initialPrompt: "Explain queues",
      title: "Queue chat",
    });

    // ON CONFLICT updates the existing row rather than inserting a duplicate.
    await recordAiThread(dbEnv, {
      threadId: THREAD_ID,
      initialPrompt: "New prompt",
      title: "Renamed",
    });
    const updated = await findAiThread(dbEnv, THREAD_ID);
    assert.equal(updated?.title, "Renamed");
    assert.equal(updated?.initialPrompt, "New prompt");
    assert.isUndefined(updated?.parentChannelId);
  });

  test("findAiThread returns null for an unknown thread", async () => {
    assert.isNull(await findAiThread(dbEnv, "999999999999999999"));
  });

  test("findAiThread fails soft to null when D1 errors", async () => {
    assert.isNull(await findAiThread(throwingDbEnv, THREAD_ID));
  });
});

describe("guilds", () => {
  const guildEnv = (allowed?: string) => ({ ALLOWED_GUILD_IDS: allowed } as unknown as Env);

  test("allows everything when the allowlist is unset or blank", () => {
    assert.isTrue(isGuildAllowed(guildEnv(undefined), OTHER_GUILD_ID));
    assert.isTrue(isGuildAllowed(guildEnv(undefined), undefined));
    assert.isTrue(isGuildAllowed(guildEnv("  "), OTHER_GUILD_ID));
  });

  test("fails closed when the allowlist is set", () => {
    const e = guildEnv(ALLOWED_GUILD_ID);
    assert.isTrue(isGuildAllowed(e, ALLOWED_GUILD_ID));
    assert.isFalse(isGuildAllowed(e, OTHER_GUILD_ID));
    assert.isFalse(isGuildAllowed(e, undefined), "DMs carry no guild id and are denied");
  });

  test("parses defensively and drops non-snowflake entries", () => {
    const e = guildEnv(` ${ALLOWED_GUILD_ID} , not-a-snowflake ,, `);
    assert.isTrue(isGuildAllowed(e, ALLOWED_GUILD_ID));
    assert.isFalse(isGuildAllowed(e, OTHER_GUILD_ID));
    assert.isFalse(isGuildAllowed(guildEnv("not-a-snowflake"), OTHER_GUILD_ID));
  });

  test("exposes the denial message", () => {
    assert.equal(GUILD_NOT_ALLOWED_MESSAGE, "This bot only works in its home server.");
  });
});

describe("spend", () => {
  test("createAiSpendSourceId is prefixed and formatUsdMicros formats dollars", () => {
    assert.match(createAiSpendSourceId(), /^aigreq:/);
    assert.equal(formatUsdMicros(1_500_000), "$1.50");
    assert.equal(formatUsdMicros(-5), "$0.00");
  });

  test("recordAiSpendEvent inserts a pending estimate row", async () => {
    const sourceId = createAiSpendSourceId();
    await recordAiSpendEvent(dbEnv, {
      kind: "ask",
      requesterUserId: ALICE_ID,
      requesterUsername: "alice",
      model: "test/model",
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      sourceId,
    });

    const row = await DB.prepare(
      "SELECT kind, requester_user_id, model, prompt_tokens, total_tokens, status FROM rag_ai_spend_events WHERE source_id = ?",
    )
      .bind(sourceId)
      .first<{
        kind: string;
        requester_user_id: string;
        model: string;
        prompt_tokens: number;
        total_tokens: number;
        status: string;
      }>();

    assert.equal(row?.kind, "ask");
    assert.equal(row?.requester_user_id, ALICE_ID);
    assert.equal(row?.model, "test/model");
    assert.equal(row?.prompt_tokens, 10);
    assert.equal(row?.total_tokens, 30);
    assert.equal(row?.status, "pending");
  });

  test("recordAiSpendEvent skips events without a requester user id", async () => {
    const before = await DB.prepare("SELECT COUNT(*) AS c FROM rag_ai_spend_events").first<{ c: number }>();
    await recordAiSpendEvent(dbEnv, { kind: "ask", model: "test/model" });
    const after = await DB.prepare("SELECT COUNT(*) AS c FROM rag_ai_spend_events").first<{ c: number }>();
    assert.equal(after?.c, before?.c);
  });
});

describe("conversation", () => {
  test("sanitizeThreadTitle strips quotes, snowflakes, and trailing punctuation", () => {
    assert.equal(sanitizeThreadTitle('"How do queues work?"'), "How do queues work");
    assert.isNull(sanitizeThreadTitle("   "));
  });

  test("fallbackThreadTitle uses a default when the prompt sanitizes to nothing", () => {
    assert.equal(fallbackThreadTitle("<@400000000000000001>"), "Chat with Ragbot");
    assert.equal(fallbackThreadTitle("Real question"), "Real question");
  });

  test("isAskThread is true only for a thread with no source message", () => {
    assert.isTrue(isAskThread({ threadId: THREAD_ID, initialPrompt: "p", title: "t" }));
    assert.isFalse(isAskThread({ threadId: THREAD_ID, sourceMessageId: MESSAGE_ID, initialPrompt: "p", title: "t" }));
    assert.isFalse(isAskThread(null));
  });

  test("buildNormalThreadConversation prepends the system prompt and the user turn", async () => {
    const config = { systemPrompt: "SYSTEM", historyLimit: 3 } as unknown as BotConfig;
    const { messages, thread } = await buildNormalThreadConversation(dbEnv, config, {
      kind: "thread_start",
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      requesterUsername: "alice",
      prompt: "Explain queues",
    });

    assert.isNull(thread);
    assert.equal(messages[0].role, "system");
    assert.isTrue(messages[0].content.startsWith("SYSTEM"));
    assert.deepEqual(messages[messages.length - 1], { role: "user", content: "alice: Explain queues" });
  });
});
