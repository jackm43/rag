import { assert, test } from "vitest";
import nacl from "tweetnacl";

import worker from "../../../workers/applications/gateway/api/middleware_client/src/index.ts";
import { activeAiBanForUser, aiBanMessage } from "../../../packages/domain/bans.ts";
import { resolveGatewayMessage } from "../../../packages/domain/mention.ts";
import { createDbMock, createEnv, createSignedRequest } from "../../helpers.ts";

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

test("/ask is denied for a raghammer-banned user before deferring", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createDbMock({ ragBan: { expires_at: BAN_EXPIRES_AT } }),
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
      user: { id: ALICE_ID, username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: BAN_DENIAL_MESSAGE, allowed_mentions: { parse: [] } },
  });
});

test("/bicture does not enqueue a job for a raghammer-banned user", async () => {
  const keyPair = nacl.sign.keyPair();
  const enqueuedJobs: unknown[] = [];
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createDbMock({ ragBan: { expires_at: BAN_EXPIRES_AT } }),
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
        name: "bicture",
        options: [{ name: "prompt", value: "a tiny jpeg test image" }],
      },
      user: { id: ALICE_ID, username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: BAN_DENIAL_MESSAGE, allowed_mentions: { parse: [] } },
  });
  assert.deepEqual(enqueuedJobs, []);
});

test("/ragjam is denied for a raghammer-banned user", async () => {
  const keyPair = nacl.sign.keyPair();
  const enqueuedJobs: unknown[] = [];
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    DB: createDbMock({ ragBan: { expires_at: BAN_EXPIRES_AT } }),
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
      user: { id: ALICE_ID, username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: BAN_DENIAL_MESSAGE, allowed_mentions: { parse: [] } },
  });
  assert.deepEqual(enqueuedJobs, []);
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
