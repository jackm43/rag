import { query, baseEnv, withFetch, clearTables } from "./helpers";
import { env } from "cloudflare:test";
import { assert, beforeEach, describe, test } from "vitest";

import {
  extractBotMentionPrompt,
  handleMessageCreate,
  resolveGatewayMessage,
  type GatewayMessageJob,
} from "../src/events/messageCreate";
import { recordAiThread } from "../src/lib/db/threads";
import { resetConfigCache } from "../src/lib/ai/config";

const BOT_USER_ID = "100000000000000001";
const GUILD_ID = "100000000000000002";
const OTHER_GUILD_ID = "100000000000000003";
const CHANNEL_ID = "200000000000000001";
const THREAD_ID = "200000000000000002";
const MESSAGE_ID = "300000000000000001";
const ALICE_ID = "400000000000000001";
const BOB_ID = "400000000000000002";
const BOT_ROLE_ID = "800000000000000001";

const bodyText = (init: RequestInit | undefined): string => {
  const inner = init?.body;
  if (typeof inner === "string") {
    return inner;
  }
  if (inner instanceof ArrayBuffer) {
    return new TextDecoder().decode(inner);
  }
  return String(inner);
};

beforeEach(async () => {
  resetConfigCache();
  await clearTables("rag_command_bans", "rag_ai_requests", "rag_ai_spend_events", "rag_ai_spend_totals", "rag_ai_threads", "rag_ai_interactions");
});

describe("mention token parsing", () => {
  test("extractBotMentionPrompt accepts prompts after the bot mention", () => {
    assert.equal(extractBotMentionPrompt("<@bot-user-id> Explain queues", "bot-user-id"), "Explain queues");
    assert.equal(extractBotMentionPrompt("<@!bot-user-id>    Explain queues", "bot-user-id"), "Explain queues");
    assert.equal(extractBotMentionPrompt("hey <@bot-user-id>", "bot-user-id"), "hey");
    assert.equal(extractBotMentionPrompt("what's up <@bot-user-id>", "bot-user-id"), "what's up");
    assert.equal(extractBotMentionPrompt("<@application-id> Explain queues", "bot-user-id"), null);
    assert.equal(extractBotMentionPrompt("<@application-id> Explain queues", "bot-user-id", "application-id"), "Explain queues");
    assert.equal(extractBotMentionPrompt("!ai Explain queues", "bot-user-id"), null);
    assert.equal(extractBotMentionPrompt("<@bot-user-id>   ", "bot-user-id"), null);
  });
});

describe("resolveGatewayMessage", () => {
  const job = (overrides: Partial<GatewayMessageJob>): GatewayMessageJob => ({
    kind: "message.received", messageId: MESSAGE_ID, channelId: CHANNEL_ID, botUserId: BOT_USER_ID,
    authorId: ALICE_ID, authorUsername: "Alice Display",
    content: `hey <@${BOT_USER_ID}>`,
    mentionUserIds: [BOT_USER_ID],
    mentionRoleIds: [],
    ...overrides,
  });

  test("resolves channel mentions into channel replies", async () => {
    await withFetch(
      () => undefined,
      async (calls) => {
        const resolved = await resolveGatewayMessage(job({}), baseEnv());
        assert.deepEqual(resolved, {
          kind: "channel_reply",
          channelId: CHANNEL_ID,
          messageId: MESSAGE_ID,
          botUserId: BOT_USER_ID,
          requesterUserId: ALICE_ID,
          requesterUsername: "Alice Display",
          prompt: "hey",
          replyMessageId: undefined,
          replyChannelId: undefined,
        });
        // Channel resolution with no role mentions and no tracked thread hits D1
        // only, never Discord REST.
        assert.deepEqual(calls.map((call) => call.url), []);
      },
    );
  });

  test("fetches bot roles for role mentions", async () => {
    await withFetch(
      (call) =>
        call.url.endsWith(`/guilds/${GUILD_ID}/members/${BOT_USER_ID}`)
          ? Response.json({ roles: [BOT_ROLE_ID] })
          : undefined,
      async (calls) => {
        const resolved = await resolveGatewayMessage(
          job({
            guildId: GUILD_ID,
            authorUsername: "alice",
            content: `<@&${BOT_ROLE_ID}> whats up`,
            mentionUserIds: [],
            mentionRoleIds: [BOT_ROLE_ID],
          }),
          baseEnv(),
        );
        assert.equal(resolved?.kind, "channel_reply");
        assert.equal(resolved?.prompt, "whats up");
        assert.ok(calls.find((call) => call.url.endsWith(`/guilds/${GUILD_ID}/members/${BOT_USER_ID}`)));
      },
    );
  });

  test("drops messages that mention nothing and track no thread", async () => {
    await withFetch(
      () => undefined,
      async (calls) => {
        const resolved = await resolveGatewayMessage(
          job({
            guildId: GUILD_ID,
            authorUsername: "alice",
            content: "!ai Explain queues",
            mentionUserIds: [],
            mentionRoleIds: [],
          }),
          baseEnv(),
        );
        assert.equal(resolved, null);
        assert.deepEqual(calls.map((call) => call.url), []);
      },
    );
  });

  test("resolves tracked thread replies without requiring a mention", async () => {
    const thread = {
      threadId: THREAD_ID,
      parentChannelId: CHANNEL_ID,
      sourceMessageId: "300000000000000004",
      requesterUserId: ALICE_ID,
      requesterUsername: "alice",
      initialPrompt: "Explain queues",
      title: "Queue chat",
    };
    await recordAiThread(baseEnv(), thread);

    const resolved = await resolveGatewayMessage(
      job({
        channelId: THREAD_ID,
        guildId: GUILD_ID,
        authorId: BOB_ID,
        authorUsername: "Bob Display",
        content: "what about dead letter queues?",
        mentionUserIds: [],
        mentionRoleIds: [],
      }),
      baseEnv(),
    );

    assert.deepEqual(resolved, {
      kind: "thread_reply",
      channelId: THREAD_ID,
      // The resolver's lookup rides along so the conversation builder does not
      // repeat the D1 read.
      thread,
      messageId: MESSAGE_ID,
      botUserId: BOT_USER_ID,
      requesterUserId: BOB_ID,
      requesterUsername: "Bob Display",
      prompt: "what about dead letter queues?",
      replyMessageId: undefined,
      replyChannelId: undefined,
    });
  });

  test("repeats the guild allowlist check", async () => {
    const resolved = await resolveGatewayMessage(
      job({ guildId: OTHER_GUILD_ID }),
      baseEnv({ ALLOWED_GUILD_IDS: GUILD_ID }),
    );
    assert.equal(resolved, null);
  });
});

  const message = (overrides: Record<string, unknown> = {}) => ({
    id: MESSAGE_ID,
    channel_id: CHANNEL_ID,
    content: `<@${BOT_USER_ID}> Explain queues`,
    author: { id: ALICE_ID, username: "alice" },
    mentions: [{ id: BOT_USER_ID }],
    ...overrides,
  });

describe("handleMessageCreate filters", () => {

  test("skips bot authors, empty prompts, and non-allowed guilds with no side effects", async () => {
    await withFetch(
      () => undefined,
      async (calls) => {
        const guardedEnv = baseEnv({ ALLOWED_GUILD_IDS: GUILD_ID });
        // Bot author.
        await handleMessageCreate(message({ author: { id: BOB_ID, username: "bot", bot: true } }), guardedEnv, BOT_USER_ID);
        // Empty prompt after mention stripping.
        await handleMessageCreate(message({ content: `<@${BOT_USER_ID}>   ` }), guardedEnv, BOT_USER_ID);
        // Disallowed guild.
        await handleMessageCreate(message({ guild_id: OTHER_GUILD_ID }), guardedEnv, BOT_USER_ID);
        // Missing bot user id (not yet READY).
        await handleMessageCreate(message({ guild_id: GUILD_ID }), guardedEnv, null);
        assert.deepEqual(calls.map((call) => call.url), []);
      },
    );
  });
});

describe("handleMessageCreate in-process reply", () => {
  test("resolves a channel mention, calls the model, and posts the reply", async () => {
    await withFetch(
      (call) => {
        if (call.url.includes("gateway.ai.cloudflare.com")) {
          return Response.json({
            choices: [{ message: { content: "Short answer." } }],
            model: "grok/grok-4.3",
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          });
        }
        return undefined;
      },
      async (calls) => {
        await handleMessageCreate(message(), baseEnv(), BOT_USER_ID);

        const modelCall = calls.find((call) => call.url.includes("gateway.ai.cloudflare.com"));
        assert.ok(modelCall, "the model was called");
        const input = JSON.parse(bodyText(modelCall.init)) as { messages: Array<{ role: string; content: string }> };
        assert.deepEqual(input.messages.slice(1), [{ role: "user", content: "alice: Explain queues" }]);

        const reply = calls.find((call) => call.url === `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`);
        assert.ok(reply, "the reply was posted to the channel");
        assert.deepEqual(JSON.parse(bodyText(reply.init)), {
          content: "Short answer.",
          allowed_mentions: { parse: [] },
        });

        // The interaction was recorded and a pending spend event was written.
        const interaction = await query("SELECT kind, response_text FROM rag_ai_interactions WHERE channel_id = ?", CHANNEL_ID).first<{ kind: string; response_text: string }>();
        assert.equal(interaction?.kind, "channel_reply");
        assert.equal(interaction?.response_text, "Short answer.");

        const spend = await query("SELECT status FROM rag_ai_spend_events WHERE requester_user_id = ?", ALICE_ID).first<{ status: string }>();
        assert.equal(spend?.status, "pending");
      },
    );
  });
});
