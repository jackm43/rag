import { query, baseEnv, insertBan, clearTables, withFetch, type Call } from "./helpers";
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
  await clearTables("rag_events", "rag_totals", "rag_command_bans", "rag_ai_requests", "rag_ai_spend_events", "rag_ai_spend_totals", "rag_ai_threads", "rag_ai_interactions");
});

const command = (
  name: string, options: Record<string, unknown> = {}, admin = false,
  extra: Record<string, unknown> = {},
) => ({
  type: 2, application_id: APP_ID, token: TOKEN, channel_id: CHANNEL_ID,
  data: { name, options: Object.entries(options).map(([name, value]) => ({ name, type: name === "user" ? 6 : 3, value })),
    ...(options.user ? { resolved: { users: { [TARGET_ID]: { id: TARGET_ID, username: "target" } } } } : {}) },
  member: { user: { id: admin ? ADMIN_ID : NON_ADMIN_ID, username: admin ? "admin" : "eve" } }, ...extra,
});
const runDispatch = (dispatchEnv: Env, interaction: Record<string, unknown>, route: (call: Call) => Response | undefined = () => undefined) =>
  withFetch(route, async calls => {
    await dispatch(interaction as never, dispatchEnv, noopCtx);
    const body = calls.find(call => call.url === EDIT_URL)?.init?.body;
    return { editBody: typeof body === "string" ? JSON.parse(body) : null, calls };
  });
const expectedReply = (content: string, users?: string[]) => ({
  content, allowed_mentions: { parse: [], ...(users ? { users } : {}) },
});

describe("registry", () => {
  test("commands map is keyed by data.name and holds all ten commands", () => {
    assert.deepEqual(
      [...commands.keys()].sort(),
      ["ask", "bicture", "rag", "ragboard", "raghammer", "ragjam", "ragspend", "ragspendboard", "ragunban", "undorag"],
    );
    for (const [name, cmd] of commands) {
      assert.equal(cmd.data.name, name);
    }
  });

  test("an unknown command edits the deferred reply", async () => {
    const { editBody } = await runDispatch(baseEnv(), command("definitely-not-a-command"));
    assert.deepEqual(editBody, expectedReply("Unknown command."));
  });

  test("a disallowed guild is surfaced as an edited reply", async () => {
    const { editBody } = await runDispatch(
      baseEnv({ ALLOWED_GUILD_IDS: ALLOWED_GUILD_ID }),
      command("ragboard", {}, false, { guild_id: "some-other-guild" }));
    assert.deepEqual(editBody, expectedReply("This bot only works in its home server."));
  });

  test("an admin-only command rejects a non-admin", async () => {
    const { editBody } = await runDispatch(baseEnv(), command("raghammer", { user: TARGET_ID, timeframe: "5m" }));
    assert.deepEqual(editBody, expectedReply("You are not allowed to use /raghammer."));
  });

  test("an AI ban gates an aiLimited command before the model runs", async () => {
    await insertBan(NON_ADMIN_ID, "2999-01-01T00:00:00.000Z");
    let aiRan = false;
    const dispatchEnv = baseEnv({ AI: { run: async () => { aiRan = true; return {}; } } });

    const { editBody } = await runDispatch(dispatchEnv, command("bicture", { prompt: "a cat" }));

    assert.match((editBody as { content: string }).content, /You cannot use AI commands until/);
    assert.isFalse(aiRan, "the model must not run once the ban is hit");
  });

  test("a thrown handler is caught and edited as a friendly failure", async () => {
    // No DB.batch on this env -> rag's insert throws -> registry catch fires.
    const brokenEnv = baseEnv({
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    });
    const { editBody } = await runDispatch(brokenEnv, command("rag", { user: TARGET_ID }));
    assert.deepEqual(editBody, expectedReply("Command failed. Try again."));
  });
});

const seedSpend = (id: string, username: string, cost: number) => query(
  "INSERT INTO rag_ai_spend_totals (requester_user_id, requester_username, estimated_cost_micros, event_count) VALUES (?, ?, ?, ?)",
  id, username, cost, 2,
).run();

describe("rag family (real D1)", () => {
  test("/rag records a rag and edits the running total", async () => {
    const { editBody } = await runDispatch(baseEnv(), command("rag", { user: TARGET_ID }));
    assert.deepEqual(editBody, expectedReply(`<@${TARGET_ID}> just ragged. Total: 1`, [TARGET_ID]));

    const total = await query("SELECT rag_count FROM rag_totals WHERE ragged_user_id = ?", TARGET_ID).first<{ rag_count: number }>();
    assert.equal(total?.rag_count, 1);
  });

  test("/rag is blocked while the invoker holds a raghammer ban", async () => {
    await insertBan(NON_ADMIN_ID, "2999-01-01T00:00:00.000Z");
    const { editBody } = await runDispatch(baseEnv(), command("rag", { user: TARGET_ID }));
    assert.match((editBody as { content: string }).content, /You cannot use \/rag until/);
  });

  test.each([
    { name: "/ragboard renders the leaderboard", commandName: "ragboard",
      seed: () => query("INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count) VALUES (?, ?, ?)", TARGET_ID, "target", 3).run(),
      content: `Ragboard\n1. target (<@${TARGET_ID}>) - 3` },
    { name: "/ragspend reports the invoker's spend", commandName: "ragspend",
      seed: () => seedSpend(NON_ADMIN_ID, "eve", 1_230_000), content: `<@${NON_ADMIN_ID}> has spent $1.23` },
    { name: "/ragspendboard renders the spend leaderboard", commandName: "ragspendboard",
      seed: () => seedSpend(TARGET_ID, "Bob", 2_500_000), content: "Ragspendboard\n1. Bob - $2.50" },
  ].map(row => [row.name, row] as const))("%s", async (_, { commandName, seed, content }) => {
    await seed();
    const { editBody } = await runDispatch(baseEnv(), command(commandName));
    assert.deepEqual(editBody, expectedReply(content));
  });

  test("/raghammer (admin) inserts a ban and confirms it", async () => {
    const { editBody } = await runDispatch(baseEnv(), command("raghammer", { user: TARGET_ID, timeframe: "5m" }, true));
    assert.deepEqual(editBody, expectedReply(`<@${TARGET_ID}> cannot use /rag for 5m.`, [TARGET_ID]));
    const ban = await query("SELECT banned_user_id FROM rag_command_bans WHERE banned_user_id = ?", TARGET_ID).first<{ banned_user_id: string }>();
    assert.equal(ban?.banned_user_id, TARGET_ID);
  });

  test("/raghammer rejects a malformed timeframe", async () => {
    const { editBody } = await runDispatch(baseEnv(), command("raghammer", { user: TARGET_ID, timeframe: "soon" }, true));
    assert.match((editBody as { content: string }).content, /Timeframe must use minutes/);
  });

  test("/raghammer rejects a timeframe past the cap instead of overflowing the expiry", async () => {
    const { editBody } = await runDispatch(baseEnv(), command("raghammer", { user: TARGET_ID, timeframe: "99999999999d" }, true));
    assert.deepEqual(editBody, expectedReply("Timeframe must be 365d or less."));
    const bans = await env.DB.prepare("SELECT COUNT(*) AS c FROM rag_command_bans").first<{ c: number }>();
    assert.equal(bans?.c, 0);
  });

  test("/ragunban (admin) removes an active ban", async () => {
    await insertBan(TARGET_ID, "2999-01-01T00:00:00.000Z");
    const { editBody } = await runDispatch(baseEnv(), command("ragunban", { user: TARGET_ID }, true));
    assert.deepEqual(editBody, expectedReply(`<@${TARGET_ID}> can use /rag again.`, [TARGET_ID]));
  });

  test("/undorag (admin) decrements the last rag", async () => {
    await env.DB.batch([
      query("INSERT INTO rag_events (ragged_user_id, ragged_username, reported_by_user_id, reported_by_username) VALUES (?, ?, ?, ?)", TARGET_ID, "target", NON_ADMIN_ID, "eve"),
      query("INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count) VALUES (?, ?, ?)", TARGET_ID, "target", 5),
    ]);
    const { editBody } = await runDispatch(baseEnv(), command("undorag", { user: TARGET_ID }, true));
    assert.deepEqual(editBody, expectedReply(`Undid the last rag for <@${TARGET_ID}>. Total: 4`, [TARGET_ID]));
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

    const { calls } = await runDispatch(dispatchEnv, command("bicture", { prompt: "a tiny jpeg" }));

    assert.equal(aiRuns.length, 1);
    assert.equal(aiRuns[0].model, "xai/grok-imagine-image");
    const edit = calls.find((call) => call.url === EDIT_URL);
    assert.ok(edit, "the deferred reply is edited");
    assert.instanceOf(edit?.init?.body, FormData);

    const spend = await query("SELECT kind FROM rag_ai_spend_events WHERE requester_user_id = ?", NON_ADMIN_ID).first<{ kind: string }>();
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
    const { editBody } = await runDispatch(dispatchEnv, command("bicture", { prompt: "a tiny jpeg" }));
    assert.deepEqual(editBody, expectedReply("Could not generate that image. Try a different prompt."));
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
      command("ragjam", { prompt: "an acoustic ballad" }),
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
      command("ask", { prompt: "How do queue retries work?" }),
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

    assert.deepEqual(editBody, expectedReply(`Started <#${THREAD_ID}>`));

    // The thread was recorded and the AI reply was posted into the thread.
    const thread = await query("SELECT thread_id FROM rag_ai_threads WHERE thread_id = ?", THREAD_ID).first<{ thread_id: string }>();
    assert.equal(thread?.thread_id, THREAD_ID);
    const reply = calls.find((call) => call.url.endsWith(`/channels/${THREAD_ID}/messages`));
    assert.ok(reply, "the AI answer is posted into the thread");
  });
});
