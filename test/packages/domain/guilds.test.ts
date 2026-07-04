import { assert, test } from "vitest";
import nacl from "tweetnacl";

import worker from "../../../workers/applications/gateway/api/middleware_client/src/index.ts";
import { GUILD_NOT_ALLOWED_MESSAGE, isGuildAllowed } from "../../../packages/domain/guilds.ts";
import { handleGatewayMessageCreate, resolveGatewayMessage } from "../../../packages/domain/mention.ts";
import { createEnv, createSignedRequest } from "../../helpers.ts";

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

test("interactions from a non-allowed guild get a friendly refusal", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    ALLOWED_GUILD_IDS: ALLOWED_GUILD_ID,
  });
  const request = createSignedRequest(
    {
      application_id: "application-id",
      channel_id: "channel-id",
      guild_id: OTHER_GUILD_ID,
      token: "interaction-token",
      type: 2,
      data: { name: "ragboard" },
      user: { id: ALICE_ID, username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: GUILD_NOT_ALLOWED_MESSAGE, allowed_mentions: { parse: [] } },
  });
});

test("PING interactions stay exempt from the guild allowlist", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    ALLOWED_GUILD_IDS: ALLOWED_GUILD_ID,
  });
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey);

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 1 });
});

test("interactions from an allowed guild pass the gate", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    ALLOWED_GUILD_IDS: ALLOWED_GUILD_ID,
  });
  const request = createSignedRequest(
    {
      application_id: "application-id",
      guild_id: ALLOWED_GUILD_ID,
      token: "interaction-token",
      type: 2,
      data: { name: "not-a-real-command" },
      user: { id: ALICE_ID, username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: "Unknown command." },
  });
});

const gatewayMessage = (guildId?: string) => ({
  id: MESSAGE_ID,
  channel_id: CHANNEL_ID,
  ...(guildId !== undefined ? { guild_id: guildId } : {}),
  content: `<@${BOT_USER_ID}> Explain queues`,
  author: { id: ALICE_ID, username: "alice" },
  mentions: [{ id: BOT_USER_ID }],
});

test("the DO drops MESSAGE_CREATE events from non-allowed guilds and DMs before enqueueing", async () => {
  const queuedJobs: unknown[] = [];
  const env = allowlistEnv({
    AI_JOBS: {
      send: async (job: unknown) => {
        queuedJobs.push(job);
      },
    },
  });

  await handleGatewayMessageCreate(gatewayMessage(OTHER_GUILD_ID), env, BOT_USER_ID);
  await handleGatewayMessageCreate(gatewayMessage(), env, BOT_USER_ID);
  assert.deepEqual(queuedJobs, []);

  await handleGatewayMessageCreate(gatewayMessage(ALLOWED_GUILD_ID), env, BOT_USER_ID);
  assert.equal(queuedJobs.length, 1);
});

test("the DO enqueues MESSAGE_CREATE events when the allowlist is unset", async () => {
  const queuedJobs: unknown[] = [];
  const env = createEnv("unused", {
    AI_JOBS: {
      send: async (job: unknown) => {
        queuedJobs.push(job);
      },
    },
  });

  await handleGatewayMessageCreate(gatewayMessage(OTHER_GUILD_ID), env, BOT_USER_ID);
  assert.equal(queuedJobs.length, 1);
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
