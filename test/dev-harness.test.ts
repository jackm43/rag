import { env } from "cloudflare:test";
import { assert, beforeEach, describe, test } from "vitest";

import {
  buildInteraction,
  buildMentionMessage,
  simulateInteraction,
  simulateMention,
  type MentionSimulationInput,
} from "../dev/harness";
import { resetConfigCache } from "../src/lib/ai/config";
import type { Env } from "../src/env";

const BOT_USER_ID = "100000000000000001";
const GUILD_ID = "100000000000000002";
const CHANNEL_ID = "200000000000000021";
const ALICE = { userId: "400000000000000001", username: "alice", globalName: "Alice", nick: "ally" };

const baseEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    DB: env.DB,
    AI_CONFIG: undefined,
    DISCORD_APPLICATION_ID: "application-id",
    DISCORD_BOT_TOKEN: "bot-token",
    CF_AIG_TOKEN: "gateway-token",
    CF_ACCOUNT_ID: "account-id",
    CF_AIG_GATEWAY_ID: "platy",
    ...overrides,
  }) as unknown as Env;

type Seen = { url: string; body: Record<string, unknown>; headers: Headers };

// A fake AI Gateway standing in for the real upstream: records what it was
// asked and answers with a fixed completion.
const fakeGateway = (reply = "Short answer.") => {
  const seen: Seen[] = [];
  const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, body: JSON.parse(await request.text()), headers: request.headers });
    return Response.json({
      choices: [{ message: { content: reply } }],
      model: "grok-4.3",
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  }) as typeof fetch;
  return { seen, upstream };
};

const mentionInput = (overrides: Partial<MentionSimulationInput> = {}): MentionSimulationInput => ({
  content: "Explain queues",
  mentionBot: true,
  identity: ALICE,
  botUserId: BOT_USER_ID,
  guildId: GUILD_ID,
  channelId: CHANNEL_ID,
  mode: "channel",
  transcript: [],
  ...overrides,
});

beforeEach(async () => {
  resetConfigCache();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rag_ai_requests"),
    env.DB.prepare("DELETE FROM rag_ai_spend_events"),
    env.DB.prepare("DELETE FROM rag_ai_threads"),
    env.DB.prepare("DELETE FROM rag_ai_interactions"),
    env.DB.prepare("DELETE FROM rag_totals"),
  ]);
});

describe("buildMentionMessage", () => {
  test("shapes the message like a gateway MESSAGE_CREATE", () => {
    const message = buildMentionMessage(mentionInput());
    assert.equal(message.content, `<@${BOT_USER_ID}> Explain queues`);
    assert.deepEqual(message.mentions, [{ id: BOT_USER_ID, username: "ragbot" }]);
    assert.equal(message.author?.username, "alice");
    assert.equal(message.member?.nick, "ally");
    assert.match(message.id, /^\d{17,20}$/);
  });

  test("inlines the referenced message for replies", () => {
    const message = buildMentionMessage(
      mentionInput({
        transcript: [{ id: "300000000000000001", role: "bot", content: "earlier reply" }],
        replyToId: "300000000000000001",
      }),
    );
    assert.equal(message.message_reference?.message_id, "300000000000000001");
    assert.equal(message.referenced_message?.author?.id, BOT_USER_ID);
  });
});

describe("simulateMention", () => {
  test("runs the real mention flow with a model override and captures the exchange", async () => {
    const gateway = fakeGateway();
    const result = await simulateMention(
      baseEnv(),
      mentionInput({ overrides: { model: "openai/gpt-4o", temperature: 0.2 } }),
      { upstream: gateway.upstream },
    );

    // The AI Gateway saw the overridden model and the dev metadata tag.
    assert.equal(gateway.seen.length, 1);
    assert.equal(gateway.seen[0].body.model, "openai/gpt-4o");
    assert.equal(gateway.seen[0].body.temperature, 0.2);
    const metadata = JSON.parse(gateway.seen[0].headers.get("cf-aig-metadata") ?? "{}");
    assert.equal(metadata.ragbot_env, "dev");
    assert.equal(metadata.ragbot_kind, "channel_reply");

    // The exchange is captured with credentials redacted, and the reply was
    // "posted" to the stubbed channel.
    assert.equal(result.ai.length, 1);
    assert.equal(result.ai[0].transport, "gateway-http");
    const request = result.ai[0].request as { headers: Record<string, string>; body: { messages: Array<{ role: string; content: string }> } };
    assert.equal(request.headers["cf-aig-authorization"], "<redacted>");
    assert.deepEqual(request.body.messages.slice(1), [{ role: "user", content: "ally: Explain queues" }]);
    assert.equal(result.replies[0]?.content, "Short answer.");
    assert.ok(result.replies[0]?.id);

    // Local D1 side effects are surfaced.
    assert.equal(result.db.interaction?.kind, "channel_reply");
    assert.equal(result.db.interaction?.model, "grok-4.3");
    assert.equal(result.db.spendEvents.length, 1);
    assert.ok(result.calls.every((call) => !call.url.includes("discord.com") || call.routed === "stub"));
  });

  test("serves the transcript as thread history in thread mode", async () => {
    const gateway = fakeGateway();
    const result = await simulateMention(
      baseEnv(),
      mentionInput({
        mode: "ask_thread",
        mentionBot: false,
        content: "and dead letter queues?",
        transcript: [
          { id: "300000000000000001", role: "user", content: "Explain queues", author: ALICE },
          { id: "300000000000000002", role: "bot", content: "Queues buffer work." },
          { id: "300000000000000003", role: "user", content: "what about retries?", author: ALICE },
          { id: "300000000000000004", role: "bot", content: "Retries use backoff." },
        ],
      }),
      { upstream: gateway.upstream },
    );

    const messages = gateway.seen[0].body.messages as Array<{ role: string; content: string }>;
    // system, initial prompt, 3 history messages, current prompt (historyLimit is 3).
    assert.equal(messages[0].role, "system");
    assert.equal(messages[1].content, "ally: Explain queues");
    assert.deepEqual(messages.slice(2).map((message) => message.role), ["assistant", "user", "assistant", "user"]);
    assert.equal(messages.at(-1)?.content, "ally: and dead letter queues?");
    assert.equal(result.db.interaction?.kind, "thread_reply");
    assert.ok(result.calls.some((call) => call.url.includes(`/channels/${CHANNEL_ID}/messages?before=`)));
  });

  test("channel mode clears a stale thread row so the message resolves as a channel reply", async () => {
    const gateway = fakeGateway();
    await simulateMention(baseEnv(), mentionInput({ mode: "thread", transcript: [] }), { upstream: gateway.upstream });
    const result = await simulateMention(baseEnv(), mentionInput({ mode: "channel" }), { upstream: gateway.upstream });
    assert.equal(result.db.interaction?.kind, "channel_reply");
  });

  test("surfaces a run with no reply instead of failing", async () => {
    const gateway = fakeGateway();
    const result = await simulateMention(
      baseEnv(),
      mentionInput({ mentionBot: false, content: "just chatting" }),
      { upstream: gateway.upstream },
    );
    assert.equal(gateway.seen.length, 0);
    assert.deepEqual(result.replies, []);
    assert.equal(result.db.interaction, null);
  });
});

describe("simulateInteraction", () => {
  test("builds an application command interaction with resolved users", () => {
    const interaction = buildInteraction(baseEnv(), {
      command: "rag",
      options: [{ name: "user", type: 6, value: "999000000000000002" }],
      resolvedUsers: { "999000000000000002": { userId: "999000000000000002", username: "target" } },
      identity: ALICE,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
    });
    assert.equal(interaction.type, 2);
    const data = interaction.data as { name: string; resolved: { users: Record<string, { username: string }> } };
    assert.equal(data.name, "rag");
    assert.equal(data.resolved.users["999000000000000002"].username, "target");
  });

  test("dispatches /rag through the registry and captures the deferred edit", async () => {
    const result = await simulateInteraction(
      baseEnv(),
      {
        command: "rag",
        options: [{ name: "user", type: 6, value: "999000000000000002" }],
        resolvedUsers: { "999000000000000002": { userId: "999000000000000002", username: "target" } },
        identity: ALICE,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
      },
      { upstream: fakeGateway().upstream },
    );
    assert.equal(result.edits.length, 1);
    assert.equal(result.edits[0].content, "<@999000000000000002> just ragged. Total: 1");
    assert.equal(result.ai.length, 0);
  });

  test("dispatches /ask: thread creation and the answer are captured", async () => {
    const gateway = fakeGateway("Retries use backoff.");
    const result = await simulateInteraction(
      baseEnv(),
      {
        command: "ask",
        options: [{ name: "prompt", type: 3, value: "How do queue retries work?" }],
        identity: ALICE,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        overrides: { model: "anthropic/claude-sonnet-5" },
      },
      { upstream: gateway.upstream },
    );
    assert.equal(result.threadsCreated.length, 1);
    assert.match(result.edits[0].content, /^Started <#\d+>$/);
    assert.equal(gateway.seen[0].body.model, "anthropic/claude-sonnet-5");
    assert.equal(result.channelMessages[0]?.content, "Retries use backoff.");
    assert.equal(result.channelMessages[0]?.channelId, result.threadsCreated[0].id);
  });
});
