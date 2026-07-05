import { assert, test } from "vitest";

import { runInteractionSession } from "@rag/discord/lib/domain/commands/session-run";
import { RAG_ADMIN_USER_IDS } from "@rag/authz/entities";
import { createDbMock, createEnv } from "../../../helpers";

// The Phase-2 processor dispatch: a verified interaction handed to the
// InteractionSession DO runs the FULL pre-flight + handler with EVERY outcome
// turned into an edit of the already-acked (type-5) deferred reply. These prove
// the all-deferred conversion — inline replies, gate rejections, and the
// guild/unknown fallbacks all arrive as an edited @original, sent as
// `workflows`, rather than a synchronous type-4 the neutral ingress can't send.

const EDIT_URL =
  "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original";

const bodyText = (init: RequestInit | undefined): string => {
  const body = init?.body;
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  return String(body);
};

// Run the dispatch under the suite's global-fetch mock and return the parsed
// body of the @original edit (the real egress hop carries it as ArrayBuffer).
const captureEdit = async (
  env: unknown,
  interaction: Record<string, unknown>,
): Promise<unknown> => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };
  try {
    await runInteractionSession(interaction as never, env as never);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const edit = calls.find((call) => call.url === EDIT_URL);
  return edit ? JSON.parse(bodyText(edit.init)) : null;
};

const command = (data: Record<string, unknown>, member: Record<string, unknown>) => ({
  type: 2,
  application_id: "application-id",
  token: "interaction-token",
  data,
  member,
});

test("an inline command is answered by editing the deferred reply, not a type-4", async () => {
  const env = createEnv("unused-public-key", {
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

  const body = await captureEdit(
    env,
    command({ name: "ragspend" }, { user: { id: "user-id", username: "alice" } }),
  );

  assert.deepEqual(body, {
    content: "<@user-id> has spent $1.23",
    allowed_mentions: { parse: [] },
  });
});

test("a Cedar denial is surfaced as an edited reply", async () => {
  const env = createEnv("unused-public-key");

  const body = await captureEdit(
    env,
    command(
      {
        name: "raghammer",
        options: [
          { name: "user", value: "2" },
          { name: "timeframe", value: "5m" },
        ],
      },
      { user: { id: "999", username: "eve" } },
    ),
  );

  assert.deepEqual(body, {
    content: "You are not allowed to use /raghammer.",
    allowed_mentions: { parse: [] },
  });
});

test("a missing required option is surfaced as an edited reply", async () => {
  const env = createEnv("unused-public-key");

  const body = await captureEdit(
    env,
    command(
      { name: "raghammer", options: [{ name: "user", value: "2" }] },
      { user: { id: RAG_ADMIN_USER_IDS[0], username: "admin" } },
    ),
  );

  assert.deepEqual(body, {
    content: "Timeframe must use minutes, hours, or days, like 5m, 1h, or 1d.",
    allowed_mentions: { parse: [] },
  });
});

test("an unknown command is surfaced as an edited reply", async () => {
  const env = createEnv("unused-public-key");

  const body = await captureEdit(
    env,
    command({ name: "definitely-not-a-command" }, { user: { id: "1", username: "alice" } }),
  );

  assert.deepEqual(body, { content: "Unknown command.", allowed_mentions: { parse: [] } });
});

test("a disallowed guild is surfaced as an edited reply", async () => {
  const env = createEnv("unused-public-key", { ALLOWED_GUILD_IDS: "home-guild" });

  const body = await captureEdit(env, {
    ...command({ name: "ragspend" }, { user: { id: "1", username: "alice" } }),
    guild_id: "some-other-guild",
  });

  assert.deepEqual(body, {
    content: "This bot only works in its home server.",
    allowed_mentions: { parse: [] },
  });
});

// Content-shape coverage for the admin/read commands that used to be asserted
// through the retired gateway /discord path — now exercised on the all-deferred
// processor path so the rendered messages stay pinned.
test("an admin /undorag edits the reply with the decremented total", async () => {
  const env = createEnv("unused-public-key", {
    DB: createDbMock({ latestRagEventId: 123, ragCount: 6 }),
  });

  const body = await captureEdit(
    env,
    command(
      { name: "undorag", options: [{ name: "user", value: "2" }] },
      { nick: "Admin", user: { id: RAG_ADMIN_USER_IDS[0], username: "admin", global_name: "Admin" } },
    ),
  );

  assert.deepEqual(body, {
    content: "Undid the last rag for <@2>. Total: 6",
    allowed_mentions: { parse: [], users: ["2"] },
  });
});

test("/ragspendboard edits the reply with the precomputed leaderboard", async () => {
  const env = createEnv("unused-public-key", {
    DB: {
      prepare: (sql: string) => ({
        bind: () => {
          throw new Error("bind should not be used");
        },
        run: async () => {
          assert.match(sql, /FROM rag_ai_spend_totals/);
          return {
            results: [
              { requester_user_id: "2", requester_username: "Bob", estimated_cost_micros: 2500000, event_count: 2 },
              { requester_user_id: "1", requester_username: "Alice", estimated_cost_micros: 10000, event_count: 1 },
            ],
          };
        },
      }),
    },
  });

  const body = await captureEdit(env, command({ name: "ragspendboard" }, { user: { id: "1", username: "alice" } }));

  assert.deepEqual(body, {
    content: "Ragspendboard\n1. Bob - $2.50\n2. Alice - $0.01",
    allowed_mentions: { parse: [] },
  });
});
