import { assert, test } from "vitest";
import * as capnp from "capnp-es";

import {
  decodeAiJobEnvelope,
  decodeAiSpendJobEnvelope,
  decodeReplyJobEnvelope,
  encodeAiJobEnvelope,
  encodeAiSpendJobEnvelope,
  encodeReplyJobEnvelope,
  MAX_FREE_TEXT_LENGTH,
  MAX_REPLY_CONTENT_LENGTH,
  MAX_USERNAME_LENGTH,
} from "../../packages/contracts/index.ts";
import { EventEnvelope } from "../../packages/contracts/envelope.ts";

const CHANNEL_ID = "200000000000000001";
const MESSAGE_ID = "300000000000000001";
const BOT_USER_ID = "100000000000000001";
const USER_ID = "400000000000000001";
const APPLICATION_ID = "500000000000000001";
const GUILD_ID = "600000000000000001";

test("AI chat jobs round-trip through the event envelope", () => {
  const job = {
    kind: "thread_start" as const,
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    botUserId: BOT_USER_ID,
    requesterUserId: USER_ID,
    requesterUsername: "alice",
    prompt: "Explain queues",
    replyMessageId: MESSAGE_ID,
    replyChannelId: CHANNEL_ID,
  };

  const bytes = encodeAiJobEnvelope(job, { source: "gateway", guildId: GUILD_ID });

  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(decodeAiJobEnvelope(bytes), job);
});

test("AI chat jobs round-trip without optional fields", () => {
  const job = {
    kind: "channel_reply" as const,
    channelId: CHANNEL_ID,
    prompt: "hey",
  };

  assert.deepEqual(decodeAiJobEnvelope(encodeAiJobEnvelope(job, { source: "gateway" })), job);
});

test("ask jobs round-trip through the event envelope", () => {
  const job = {
    kind: "ask" as const,
    channelId: CHANNEL_ID,
    requesterUserId: USER_ID,
    requesterUsername: "alice",
    prompt: "How do queue retries work?",
  };

  assert.deepEqual(decodeAiJobEnvelope(encodeAiJobEnvelope(job, { source: "interactions" })), job);
});

test("ragjam jobs round-trip through the event envelope", () => {
  const job = {
    kind: "ragjam" as const,
    applicationId: APPLICATION_ID,
    interactionToken: "interaction-token",
    channelId: CHANNEL_ID,
    requesterUserId: USER_ID,
    requesterUsername: "alice",
    prompt: "A warm acoustic folk ballad",
    lyrics: "Walking down a dusty road",
  };

  assert.deepEqual(decodeAiJobEnvelope(encodeAiJobEnvelope(job, { source: "interactions" })), job);
});

test("bicture jobs round-trip through the event envelope", () => {
  const job = {
    kind: "bicture" as const,
    applicationId: APPLICATION_ID,
    interactionToken: "interaction-token",
    channelId: CHANNEL_ID,
    requesterUserId: USER_ID,
    requesterUsername: "alice",
    prompt: "a tiny jpeg test image",
  };

  assert.deepEqual(decodeAiJobEnvelope(encodeAiJobEnvelope(job, { source: "interactions" })), job);
});

test("message.received jobs round-trip through the event envelope", () => {
  const job = {
    kind: "message.received" as const,
    messageId: MESSAGE_ID,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    botUserId: BOT_USER_ID,
    authorId: USER_ID,
    authorUsername: "alice",
    content: `<@${BOT_USER_ID}> Explain queues`,
    mentionUserIds: [BOT_USER_ID],
    mentionRoleIds: [USER_ID],
    replyMessageId: MESSAGE_ID,
    replyChannelId: CHANNEL_ID,
  };

  assert.deepEqual(decodeAiJobEnvelope(encodeAiJobEnvelope(job, { source: "gateway" })), job);

  const minimal = {
    kind: "message.received" as const,
    messageId: MESSAGE_ID,
    channelId: CHANNEL_ID,
    botUserId: BOT_USER_ID,
    content: "",
    mentionUserIds: [],
    mentionRoleIds: [],
  };
  assert.deepEqual(decodeAiJobEnvelope(encodeAiJobEnvelope(minimal, { source: "gateway" })), minimal);
});

test("message.received encode rejects malformed mention ids", () => {
  assert.throws(() =>
    encodeAiJobEnvelope(
      {
        kind: "message.received",
        messageId: MESSAGE_ID,
        channelId: CHANNEL_ID,
        botUserId: BOT_USER_ID,
        content: "hey",
        mentionUserIds: ["../users/@me"],
        mentionRoleIds: [],
      },
      { source: "gateway" },
    ),
  );
});

test("reply jobs round-trip through the event envelope", () => {
  const channelReply = {
    kind: "reply.channel_message" as const,
    channelId: CHANNEL_ID,
    content: "Short answer.",
  };
  const interactionEdit = {
    kind: "reply.interaction_edit" as const,
    applicationId: APPLICATION_ID,
    interactionToken: "interaction-token",
    content: "Prompt: a tiny jpeg test image",
  };

  const channelBytes = encodeReplyJobEnvelope(channelReply, { source: "worker" });
  assert.deepEqual(decodeReplyJobEnvelope(channelBytes), channelReply);
  assert.deepEqual(
    decodeReplyJobEnvelope(encodeReplyJobEnvelope(interactionEdit, { source: "worker" })),
    interactionEdit,
  );
  // Reply payloads are not AI jobs and vice versa.
  assert.equal(decodeAiJobEnvelope(channelBytes), null);
  assert.equal(
    decodeReplyJobEnvelope(
      encodeAiJobEnvelope({ kind: "channel_reply", channelId: CHANNEL_ID, prompt: "hey" }, { source: "gateway" }),
    ),
    null,
  );
});

test("reply jobs allow empty content but reject bad ids and oversized content", () => {
  const empty = { kind: "reply.channel_message" as const, channelId: CHANNEL_ID, content: "" };
  assert.deepEqual(decodeReplyJobEnvelope(encodeReplyJobEnvelope(empty, { source: "worker" })), empty);

  assert.throws(() =>
    encodeReplyJobEnvelope(
      { kind: "reply.channel_message", channelId: "../users/@me", content: "hey" },
      { source: "worker" },
    ),
  );
  assert.throws(() =>
    encodeReplyJobEnvelope(
      {
        kind: "reply.channel_message",
        channelId: CHANNEL_ID,
        content: "a".repeat(MAX_REPLY_CONTENT_LENGTH + 1),
      },
      { source: "worker" },
    ),
  );
});

test("spend jobs round-trip through the event envelope", () => {
  const job = { spendEventId: "aigreq:6e2c9f3a-72d4-4be9-9a51-2f43a1f2b7cd" };
  const bytes = encodeAiSpendJobEnvelope(job, { source: "worker" });

  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(decodeAiSpendJobEnvelope(bytes), job);
  assert.equal(decodeAiJobEnvelope(bytes), null);
});

test("encode rejects malformed snowflake ids", () => {
  assert.throws(() =>
    encodeAiJobEnvelope(
      { kind: "channel_reply", channelId: "channel-id", prompt: "hey" },
      { source: "gateway" },
    ),
  );
  assert.throws(() =>
    encodeAiJobEnvelope(
      { kind: "channel_reply", channelId: CHANNEL_ID, requesterUserId: "1", prompt: "hey" },
      { source: "gateway" },
    ),
  );
  assert.throws(() =>
    encodeAiJobEnvelope(
      { kind: "channel_reply", channelId: CHANNEL_ID, prompt: "hey" },
      { source: "gateway", guildId: "guild-id" },
    ),
  );
});

test("encode rejects free text and usernames over the length caps", () => {
  assert.throws(() =>
    encodeAiJobEnvelope(
      { kind: "channel_reply", channelId: CHANNEL_ID, prompt: "a".repeat(MAX_FREE_TEXT_LENGTH + 1) },
      { source: "gateway" },
    ),
  );
  assert.throws(() =>
    encodeAiJobEnvelope(
      {
        kind: "channel_reply",
        channelId: CHANNEL_ID,
        requesterUsername: "a".repeat(MAX_USERNAME_LENGTH + 1),
        prompt: "hey",
      },
      { source: "gateway" },
    ),
  );
});

test("decode returns null for garbage bytes and non-envelope payloads", () => {
  assert.equal(decodeAiJobEnvelope(new Uint8Array([1, 2, 3, 4, 5])), null);
  assert.equal(decodeAiJobEnvelope(new TextEncoder().encode('{"kind":"channel_reply"}')), null);
  assert.equal(decodeAiJobEnvelope({ kind: "channel_reply", channelId: CHANNEL_ID, prompt: "hey" }), null);
  assert.equal(decodeAiJobEnvelope(undefined), null);
  assert.equal(decodeAiSpendJobEnvelope(new Uint8Array([1, 2, 3, 4, 5])), null);
  assert.equal(decodeAiSpendJobEnvelope({ spendEventId: "aigreq:raw-json" }), null);
});

test("decode re-validates payload values from untrusted producers", () => {
  const message = new capnp.Message();
  const envelope = message.initRoot(EventEnvelope);
  envelope.v = 1;
  envelope.type = "channel_reply";
  envelope.id = "envelope-id";
  envelope.occurredAt = new Date().toISOString();
  envelope.source = "gateway";
  const payload = envelope.payload._initChannelReply();
  payload.channelId = "../users/@me";
  payload.prompt = "hey";

  assert.equal(decodeAiJobEnvelope(new Uint8Array(message.toArrayBuffer())), null);
});

test("decode rejects hostile frame headers without huge allocations", () => {
  // Header claims ~4 billion segments; must be rejected before any allocation.
  const hugeSegmentCount = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.equal(decodeAiJobEnvelope(hugeSegmentCount), null);

  // Header claims a segment far larger than the buffer.
  const hugeSegmentLength = new Uint8Array([0, 0, 0, 0, 0xff, 0xff, 0xff, 0x7f]);
  assert.equal(decodeAiJobEnvelope(hugeSegmentLength), null);
});
