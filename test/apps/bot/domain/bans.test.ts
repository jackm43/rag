import { assert, test } from "vitest";

import { activeAiBanForUser, aiBanMessage } from "@rag/discord/domain/bans";
import { runInteractionSession } from "@rag/discord/commands/session-run";
import { resolveGatewayMessage } from "@rag/discord/domain/mention";
import { createDbMock, createEnv } from "../../../helpers";

const EDIT_URL =
  "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original";

const editBody = (init: RequestInit | undefined): unknown => {
  const body = init?.body;
  const text = typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer);
  return JSON.parse(text);
};

const BOT_USER_ID = "100000000000000001";
const CHANNEL_ID = "200000000000000001";
const MESSAGE_ID = "300000000000000001";
const ALICE_ID = "400000000000000001";

const BAN_EXPIRES_AT = "2030-01-02T03:04:05.000Z";
const BAN_DENIAL_MESSAGE = `You cannot use AI commands until <t:${Math.floor(Date.parse(BAN_EXPIRES_AT) / 1000)}:R>.`;

test("aiBanMessage renders the expiry as a Discord relative timestamp", () => {
  assert.equal(aiBanMessage(BAN_EXPIRES_AT), BAN_DENIAL_MESSAGE);
  assert.equal(aiBanMessage("not-a-date"), "You cannot use AI commands until not-a-date.");
});

test("activeAiBanForUser fails open when D1 errors", async () => {
  const env = {
    DB: {
      prepare: () => {
        throw new Error("d1 unavailable");
      },
    },
  } as never;

  assert.isNull(await activeAiBanForUser(env, ALICE_ID, new Date()));
});

test("a raghammer-banned user's AI command is refused with the ban message on the deferred reply", async () => {
  // All commands defer now: the processor DO runs the same authorize+limit gate
  // and edits the deferred reply with the ban message instead of a synchronous
  // type-4. The ban still short-circuits before any AI work.
  const env = createEnv("unused-public-key", {
    DB: createDbMock({ ragBan: { expires_at: BAN_EXPIRES_AT } }),
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };
  try {
    await runInteractionSession(
      {
        type: 2,
        application_id: "application-id",
        token: "interaction-token",
        data: { name: "ask", options: [{ name: "prompt", value: "How do queue retries work?" }] },
        member: { user: { id: ALICE_ID, username: "alice" } },
      } as never,
      env as never,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const edit = calls.find((call) => call.url === EDIT_URL);
  assert.ok(edit, "the ban denial is delivered as an edit");
  assert.deepEqual(editBody(edit.init), {
    content: BAN_DENIAL_MESSAGE,
    allowed_mentions: { parse: [] },
  });
  // No AI Gateway call: the ban gate runs before any model work.
  assert.isUndefined(calls.find((call) => call.url.includes("gateway.ai.cloudflare.com")));
});

test("gateway mentions from a banned user are ignored with no notice", async () => {
  const outboxJobs: unknown[] = [];
  const env = createEnv("unused", {
    DB: createDbMock({ ragBan: { expires_at: BAN_EXPIRES_AT } }),
    DISCORD_OUTBOX: {
      send: async (body: unknown) => {
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
  assert.deepEqual(outboxJobs, [], "banned users get no denial notice on the gateway path");
});
