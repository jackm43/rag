import { env } from "cloudflare:test";
import { assert, beforeEach, describe, test } from "vitest";

import { commands } from "../src/commands";
import { dispatch, RAG_ADMIN_USER_IDS } from "../src/structs/registry";
import { resetConfigCache } from "../src/lib/ai/config";
import type { Env } from "../src/env";

const APP_ID = "application-id";
const TOKEN = "interaction-token";
const EDIT_URL = `https://discord.com/api/v10/webhooks/${APP_ID}/${TOKEN}/messages/@original`;

const ADMIN_ID = RAG_ADMIN_USER_IDS[0];
const NON_ADMIN_ID = "999000000000000001";
const TARGET_ID = "999000000000000002";
const ALLOWED_GUILD_ID = "100000000000000009";
const CHANNEL_ID = "200000000000000009";
const THREAD_ID = "200000000000000010";

const noopCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

// Every mutable table the command handlers touch, cleared between tests so the
// row-count assertions stay independent (storage is per-file, not per-test).
beforeEach(async () => {
  resetConfigCache();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rag_events"),
    env.DB.prepare("DELETE FROM rag_totals"),
    env.DB.prepare("DELETE FROM rag_command_bans"),
    env.DB.prepare("DELETE FROM rag_ai_requests"),
    env.DB.prepare("DELETE FROM rag_ai_spend_events"),
    env.DB.prepare("DELETE FROM rag_ai_spend_totals"),
    env.DB.prepare("DELETE FROM rag_ai_threads"),
    env.DB.prepare("DELETE FROM rag_ai_interactions"),
  ]);
});

const baseEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    DB: env.DB,
    AI_CONFIG: undefined,
    DISCORD_APPLICATION_ID: APP_ID,
    DISCORD_BOT_TOKEN: "bot-token",
    CF_AIG_TOKEN: "gateway-token",
    CF_ACCOUNT_ID: "account-id",
    CF_AIG_GATEWAY_ID: "platy",
    ...overrides,
  }) as unknown as Env;

const command = (
  data: Record<string, unknown>,
  member: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: 2,
  application_id: APP_ID,
  token: TOKEN,
  channel_id: CHANNEL_ID,
  data,
  member,
  ...extra,
});

const userOption = (value: string) => ({ name: "user", type: 6, value });
const resolvedUser = (id: string, username: string) => ({ users: { [id]: { id, username } } });

type Call = { url: string; init?: RequestInit };

// Runs dispatch under a routing fetch mock and returns the parsed JSON body of
// the @original edit (media edits travel as FormData and parse to null).
const runDispatch = async (
  dispatchEnv: Env,
  interaction: Record<string, unknown>,
  route: (call: Call) => Response | undefined = () => undefined,
): Promise<{ editBody: unknown; calls: Call[] }> => {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return route(call) ?? new Response("{}", { status: 200 });
  };
  try {
    await dispatch(interaction as never, dispatchEnv, noopCtx);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const edit = calls.find((call) => call.url === EDIT_URL);
  const body = edit?.init?.body;
  const editBody = typeof body === "string" ? JSON.parse(body) : null;
  return { editBody, calls };
};

const insertBan = (userId: string, expiresAt: string) =>
  env.DB.prepare(
    "INSERT INTO rag_command_bans (banned_user_id, banned_by_user_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(userId, "moderator", expiresAt)
    .run();

describe("registry", () => {
  test("commands map is keyed by data.name and holds all ten commands", () => {
    assert.deepEqual(
      [...commands.keys()].sort(),
      [
        "ask",
        "bicture",
        "rag",
        "ragboard",
        "raghammer",
        "ragjam",
        "ragspend",
        "ragspendboard",
        "ragunban",
        "undorag",
      ],
    );
    for (const [name, cmd] of commands) {
      assert.equal(cmd.data.name, name);
    }
  });

  test("an unknown command edits the deferred reply", async () => {
    const { editBody } = await runDispatch(
      baseEnv(),
      command({ name: "definitely-not-a-command" }, { user: { id: NON_ADMIN_ID, username: "eve" } }),
    );
    assert.deepEqual(editBody, { content: "Unknown command.", allowed_mentions: { parse: [] } });
  });

  test("a disallowed guild is surfaced as an edited reply", async () => {
    const { editBody } = await runDispatch(
      baseEnv({ ALLOWED_GUILD_IDS: ALLOWED_GUILD_ID }),
      command({ name: "ragboard" }, { user: { id: NON_ADMIN_ID, username: "eve" } }, { guild_id: "some-other-guild" }),
    );
    assert.deepEqual(editBody, {
      content: "This bot only works in its home server.",
      allowed_mentions: { parse: [] },
    });
  });

  test("an admin-only command rejects a non-admin", async () => {
    const { editBody } = await runDispatch(
      baseEnv(),
      command(
        { name: "raghammer", options: [userOption(TARGET_ID), { name: "timeframe", type: 3, value: "5m" }] },
        { user: { id: NON_ADMIN_ID, username: "eve" } },
      ),
    );
    assert.deepEqual(editBody, {
      content: "You are not allowed to use /raghammer.",
      allowed_mentions: { parse: [] },
    });
  });

  test("an AI ban gates an aiLimited command before the model runs", async () => {
    await insertBan(NON_ADMIN_ID, "2999-01-01T00:00:00.000Z");
    let aiRan = false;
    const dispatchEnv = baseEnv({ AI: { run: async () => { aiRan = true; return {}; } } });

    const { editBody } = await runDispatch(
      dispatchEnv,
      command(
        { name: "bicture", options: [{ name: "prompt", type: 3, value: "a cat" }] },
        { user: { id: NON_ADMIN_ID, username: "eve" } },
      ),
    );

    assert.match((editBody as { content: string }).content, /You cannot use AI commands until/);
    assert.isFalse(aiRan, "the model must not run once the ban is hit");
  });

  test("a thrown handler is caught and edited as a friendly failure", async () => {
    // No DB.batch on this env -> rag's insert throws -> registry catch fires.
    const brokenEnv = baseEnv({
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    });
    const { editBody } = await runDispatch(
      brokenEnv,
      command(
        { name: "rag", options: [userOption(TARGET_ID)], resolved: resolvedUser(TARGET_ID, "target") },
        { user: { id: NON_ADMIN_ID, username: "eve" } },
      ),
    );
    assert.deepEqual(editBody, { content: "Command failed. Try again.", allowed_mentions: { parse: [] } });
  });
});

describe("rag family (real D1)", () => {
  test("/rag records a rag and edits the running total", async () => {
    const { editBody } = await runDispatch(
      baseEnv(),
      command(
        { name: "rag", options: [userOption(TARGET_ID)], resolved: resolvedUser(TARGET_ID, "target") },
        { user: { id: NON_ADMIN_ID, username: "eve" } },
      ),
    );
    assert.deepEqual(editBody, {
      content: `<@${TARGET_ID}> just ragged. Total: 1`,
      allowed_mentions: { parse: [], users: [TARGET_ID] },
    });

    const total = await env.DB.prepare("SELECT rag_count FROM rag_totals WHERE ragged_user_id = ?")
      .bind(TARGET_ID)
      .first<{ rag_count: number }>();
    assert.equal(total?.rag_count, 1);
  });

  test("/rag is blocked while the invoker holds a raghammer ban", async () => {
    await insertBan(NON_ADMIN_ID, "2999-01-01T00:00:00.000Z");
    const { editBody } = await runDispatch(
      baseEnv(),
      command(
        { name: "rag", options: [userOption(TARGET_ID)], resolved: resolvedUser(TARGET_ID, "target") },
        { user: { id: NON_ADMIN_ID, username: "eve" } },
      ),
    );
    assert.match((editBody as { content: string }).content, /You cannot use \/rag until/);
  });

  test("/ragboard renders the leaderboard", async () => {
    await env.DB.prepare(
      "INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count) VALUES (?, ?, ?)",
    )
      .bind(TARGET_ID, "target", 3)
      .run();
    const { editBody } = await runDispatch(
      baseEnv(),
      command({ name: "ragboard" }, { user: { id: NON_ADMIN_ID, username: "eve" } }),
    );
    assert.deepEqual(editBody, {
      content: `Ragboard\n1. target (<@${TARGET_ID}>) - 3`,
      allowed_mentions: { parse: [] },
    });
  });

  test("/ragspend reports the invoker's spend", async () => {
    await env.DB.prepare(
      "INSERT INTO rag_ai_spend_totals (requester_user_id, requester_username, estimated_cost_micros, event_count) VALUES (?, ?, ?, ?)",
    )
      .bind(NON_ADMIN_ID, "eve", 1_230_000, 2)
      .run();
    const { editBody } = await runDispatch(
      baseEnv(),
      command({ name: "ragspend" }, { user: { id: NON_ADMIN_ID, username: "eve" } }),
    );
    assert.deepEqual(editBody, {
      content: `<@${NON_ADMIN_ID}> has spent $1.23`,
      allowed_mentions: { parse: [] },
    });
  });

  test("/ragspendboard renders the spend leaderboard", async () => {
    await env.DB.prepare(
      "INSERT INTO rag_ai_spend_totals (requester_user_id, requester_username, estimated_cost_micros, event_count) VALUES (?, ?, ?, ?)",
    )
      .bind(TARGET_ID, "Bob", 2_500_000, 2)
      .run();
    const { editBody } = await runDispatch(
      baseEnv(),
      command({ name: "ragspendboard" }, { user: { id: NON_ADMIN_ID, username: "eve" } }),
    );
    assert.deepEqual(editBody, {
      content: "Ragspendboard\n1. Bob - $2.50",
      allowed_mentions: { parse: [] },
    });
  });

  test("/raghammer (admin) inserts a ban and confirms it", async () => {
    const { editBody } = await runDispatch(
      baseEnv(),
      command(
        { name: "raghammer", options: [userOption(TARGET_ID), { name: "timeframe", type: 3, value: "5m" }], resolved: resolvedUser(TARGET_ID, "target") },
        { user: { id: ADMIN_ID, username: "admin" } },
      ),
    );
    assert.deepEqual(editBody, {
      content: `<@${TARGET_ID}> cannot use /rag for 5m.`,
      allowed_mentions: { parse: [], users: [TARGET_ID] },
    });
    const ban = await env.DB.prepare("SELECT banned_user_id FROM rag_command_bans WHERE banned_user_id = ?")
      .bind(TARGET_ID)
      .first<{ banned_user_id: string }>();
    assert.equal(ban?.banned_user_id, TARGET_ID);
  });

  test("/raghammer rejects a malformed timeframe", async () => {
    const { editBody } = await runDispatch(
      baseEnv(),
      command(
        { name: "raghammer", options: [userOption(TARGET_ID), { name: "timeframe", type: 3, value: "soon" }], resolved: resolvedUser(TARGET_ID, "target") },
        { user: { id: ADMIN_ID, username: "admin" } },
      ),
    );
    assert.match((editBody as { content: string }).content, /Timeframe must use minutes/);
  });

  test("/raghammer rejects a timeframe past the cap instead of overflowing the expiry", async () => {
    const { editBody } = await runDispatch(
      baseEnv(),
      command(
        { name: "raghammer", options: [userOption(TARGET_ID), { name: "timeframe", type: 3, value: "99999999999d" }], resolved: resolvedUser(TARGET_ID, "target") },
        { user: { id: ADMIN_ID, username: "admin" } },
      ),
    );
    assert.deepEqual(editBody, { content: "Timeframe must be 365d or less.", allowed_mentions: { parse: [] } });
    const bans = await env.DB.prepare("SELECT COUNT(*) AS c FROM rag_command_bans").first<{ c: number }>();
    assert.equal(bans?.c, 0);
  });

  test("/ragunban (admin) removes an active ban", async () => {
    await insertBan(TARGET_ID, "2999-01-01T00:00:00.000Z");
    const { editBody } = await runDispatch(
      baseEnv(),
      command(
        { name: "ragunban", options: [userOption(TARGET_ID)] },
        { user: { id: ADMIN_ID, username: "admin" } },
      ),
    );
    assert.deepEqual(editBody, {
      content: `<@${TARGET_ID}> can use /rag again.`,
      allowed_mentions: { parse: [], users: [TARGET_ID] },
    });
  });

  test("/undorag (admin) decrements the last rag", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rag_events (ragged_user_id, ragged_username, reported_by_user_id, reported_by_username) VALUES (?, ?, ?, ?)").bind(TARGET_ID, "target", NON_ADMIN_ID, "eve"),
      env.DB.prepare("INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count) VALUES (?, ?, ?)").bind(TARGET_ID, "target", 5),
    ]);
    const { editBody } = await runDispatch(
      baseEnv(),
      command(
        { name: "undorag", options: [userOption(TARGET_ID)] },
        { user: { id: ADMIN_ID, username: "admin" } },
      ),
    );
    assert.deepEqual(editBody, {
      content: `Undid the last rag for <@${TARGET_ID}>. Total: 4`,
      allowed_mentions: { parse: [], users: [TARGET_ID] },
    });
  });
});

describe("AI commands (mocked model/REST boundary)", () => {
  test("/bicture generates an image and edits with an attachment", async () => {
    const imageBase64 = Buffer.from(new Uint8Array([255, 216, 255, 217])).toString("base64");
    const aiRuns: Array<{ model: string }> = [];
    const dispatchEnv = baseEnv({
      AI: {
        run: async (model: string) => {
          aiRuns.push({ model });
          return { result: { image: `data:image/png;base64,${imageBase64}` } };
        },
      },
    });

    const { calls } = await runDispatch(
      dispatchEnv,
      command(
        { name: "bicture", options: [{ name: "prompt", type: 3, value: "a tiny jpeg" }] },
        { user: { id: NON_ADMIN_ID, username: "eve" } },
      ),
    );

    assert.equal(aiRuns.length, 1);
    assert.equal(aiRuns[0].model, "xai/grok-imagine-image");
    const edit = calls.find((call) => call.url === EDIT_URL);
    assert.ok(edit, "the deferred reply is edited");
    assert.instanceOf(edit?.init?.body, FormData);

    const spend = await env.DB.prepare("SELECT kind FROM rag_ai_spend_events WHERE requester_user_id = ?")
      .bind(NON_ADMIN_ID)
      .first<{ kind: string }>();
    assert.equal(spend?.kind, "bicture");
  });

  test("/bicture edits a failure notice when generation throws", async () => {
    const dispatchEnv = baseEnv({
      AI: {
        run: async () => {
          throw new Error("model exploded");
        },
      },
    });
    const { editBody } = await runDispatch(
      dispatchEnv,
      command(
        { name: "bicture", options: [{ name: "prompt", type: 3, value: "a tiny jpeg" }] },
        { user: { id: NON_ADMIN_ID, username: "eve" } },
      ),
    );
    assert.deepEqual(editBody, {
      content: "Could not generate that image. Try a different prompt.",
      allowed_mentions: { parse: [] },
    });
  });

  test("/ragjam generates audio, downloads it, and edits with an attachment", async () => {
    const audioBytes = new Uint8Array([73, 68, 51, 4]);
    const dispatchEnv = baseEnv({
      AI: {
        run: async () => ({ result: { audio: "https://example.com/generated-song.mp3" } }),
      },
    });

    const { calls } = await runDispatch(
      dispatchEnv,
      command(
        { name: "ragjam", options: [{ name: "prompt", type: 3, value: "an acoustic ballad" }] },
        { user: { id: NON_ADMIN_ID, username: "eve" } },
      ),
      (call) =>
        call.url === "https://example.com/generated-song.mp3"
          ? new Response(audioBytes, {
              status: 200,
              headers: { "content-type": "audio/mpeg", "content-length": String(audioBytes.byteLength) },
            })
          : undefined,
    );

    const download = calls.find((call) => call.url === "https://example.com/generated-song.mp3");
    assert.ok(download, "the generated audio is downloaded");
    const edit = calls.find((call) => call.url === EDIT_URL);
    assert.instanceOf(edit?.init?.body, FormData);
  });

  test("/ask creates a thread, edits 'Started', and answers into the thread", async () => {
    const dispatchEnv = baseEnv({
      AI: { run: async () => ({}) },
    });

    const { editBody, calls } = await runDispatch(
      dispatchEnv,
      command(
        { name: "ask", options: [{ name: "prompt", type: 3, value: "How do queue retries work?" }] },
        { user: { id: NON_ADMIN_ID, username: "eve" } },
      ),
      (call) => {
        // Thread creation returns a thread channel.
        if (call.url.endsWith(`/channels/${CHANNEL_ID}/threads`) && call.init?.method === "POST") {
          return Response.json({ id: THREAD_ID, type: 11 });
        }
        // resolveThreadParentChannelId's fetchChannel: a normal (non-thread) channel.
        if (call.url.endsWith(`/channels/${CHANNEL_ID}`) && (call.init?.method ?? "GET") === "GET") {
          return Response.json({ id: CHANNEL_ID, type: 0 });
        }
        // The model call over the AI gateway.
        if (call.url.includes("gateway.ai.cloudflare.com")) {
          return Response.json({
            choices: [{ message: { content: "Retries use backoff." } }],
            model: "grok/grok-4.3",
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
          });
        }
        return undefined;
      },
    );

    assert.deepEqual(editBody, {
      content: `Started <#${THREAD_ID}>`,
      allowed_mentions: { parse: [] },
    });

    // The thread was recorded and the AI reply was posted into the thread.
    const thread = await env.DB.prepare("SELECT thread_id FROM rag_ai_threads WHERE thread_id = ?")
      .bind(THREAD_ID)
      .first<{ thread_id: string }>();
    assert.equal(thread?.thread_id, THREAD_ID);
    const reply = calls.find((call) => call.url.endsWith(`/channels/${THREAD_ID}/messages`));
    assert.ok(reply, "the AI answer is posted into the thread");
  });
});
