import { assert, test } from "vitest";

import { isGuildAllowed } from "@rag/discord/lib/domain/guilds";
import { handleGatewayMessageCreate, resolveGatewayMessage } from "@rag/discord/lib/domain/mention";
import { createEnv } from "../../../helpers";

const BOT_USER_ID = "100000000000000001";
const ALLOWED_GUILD_ID = "100000000000000002";
const OTHER_GUILD_ID = "100000000000000003";
const CHANNEL_ID = "200000000000000001";
const MESSAGE_ID = "300000000000000001";
const ALICE_ID = "400000000000000001";

const allowlistEnv = (overrides: Record<string, unknown> = {}) =>
  createEnv("unused", { ALLOWED_GUILD_IDS: ALLOWED_GUILD_ID, ...overrides });

test("isGuildAllowed allows everything when the allowlist is unset or blank", () => {
  assert.isTrue(isGuildAllowed(createEnv("unused"), OTHER_GUILD_ID));
  assert.isTrue(isGuildAllowed(createEnv("unused"), undefined));
  assert.isTrue(isGuildAllowed(createEnv("unused", { ALLOWED_GUILD_IDS: "  " }), OTHER_GUILD_ID));
});

test("isGuildAllowed fails closed when the allowlist is set", () => {
  const env = allowlistEnv();
  assert.isTrue(isGuildAllowed(env, ALLOWED_GUILD_ID));
  assert.isFalse(isGuildAllowed(env, OTHER_GUILD_ID));
  assert.isFalse(isGuildAllowed(env, undefined), "DMs carry no guild id and are denied");
});

test("isGuildAllowed parses defensively and drops non-snowflake entries", () => {
  const env = createEnv("unused", {
    ALLOWED_GUILD_IDS: ` ${ALLOWED_GUILD_ID} , not-a-snowflake ,, `,
  });
  assert.isTrue(isGuildAllowed(env, ALLOWED_GUILD_ID));
  assert.isFalse(isGuildAllowed(env, OTHER_GUILD_ID));

  const garbageOnly = createEnv("unused", { ALLOWED_GUILD_IDS: "not-a-snowflake" });
  assert.isFalse(isGuildAllowed(garbageOnly, OTHER_GUILD_ID), "garbage config denies, never allows");
});

// The all-deferred equivalents — a disallowed guild and an unknown command are
// surfaced as edited replies from the processor DO — live in session-dispatch;
// PING exemption lives in webhooks-interactions. This file keeps the guild
// allowlist unit + the gateway→DO mention path.

const gatewayMessage = (guildId?: string) => ({
  id: MESSAGE_ID,
  channel_id: CHANNEL_ID,
  ...(guildId !== undefined ? { guild_id: guildId } : {}),
  content: `<@${BOT_USER_ID}> Explain queues`,
  author: { id: ALICE_ID, username: "alice" },
  mentions: [{ id: BOT_USER_ID }],
});

// Capture the processor-DO kicks without running the full mention resolution.
const mentionKickSpy = (base: Record<string, unknown>) => {
  const kicks: unknown[] = [];
  const env = createEnv("unused", {
    ...base,
    INTERACTION_SESSION: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ runMention: async (job: unknown) => { kicks.push(job); } }),
    },
  });
  return { kicks, env };
};

test("the gateway drops MESSAGE_CREATE events from non-allowed guilds and DMs before kicking the DO", async () => {
  const { kicks, env } = mentionKickSpy({ ALLOWED_GUILD_IDS: ALLOWED_GUILD_ID });

  await handleGatewayMessageCreate(gatewayMessage(OTHER_GUILD_ID), env, BOT_USER_ID);
  await handleGatewayMessageCreate(gatewayMessage(), env, BOT_USER_ID);
  assert.deepEqual(kicks, []);

  await handleGatewayMessageCreate(gatewayMessage(ALLOWED_GUILD_ID), env, BOT_USER_ID);
  assert.equal(kicks.length, 1);
});

test("the gateway kicks the DO for MESSAGE_CREATE events when the allowlist is unset", async () => {
  const { kicks, env } = mentionKickSpy({});

  await handleGatewayMessageCreate(gatewayMessage(OTHER_GUILD_ID), env, BOT_USER_ID);
  assert.equal(kicks.length, 1);
});

test("workflows message.received resolution repeats the allowlist check", async () => {
  const env = allowlistEnv();

  const job = await resolveGatewayMessage(
    {
      kind: "message.received",
      messageId: MESSAGE_ID,
      channelId: CHANNEL_ID,
      guildId: OTHER_GUILD_ID,
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
});
