import * as capnp from "capnp-es";
import type {
  AiAskJob,
  AiChatJob,
  AiJob,
  AiSpendJob,
  BictureJob,
  MessageReceivedJob,
  RagjamJob,
  ReplyJob,
} from "../types";
import {
  ChatPayload,
  EventEnvelope,
  EventEnvelope_Payload_Which,
} from "./envelope";
import { isOptionalSnowflake, validateAiJob, validateAiSpendJob, validateReplyJob } from "./validate";

export {
  isSnowflake,
  MAX_FREE_TEXT_LENGTH,
  MAX_INTERACTION_TOKEN_LENGTH,
  MAX_MENTION_IDS,
  MAX_REPLY_CONTENT_LENGTH,
  MAX_SPEND_EVENT_ID_LENGTH,
  MAX_USERNAME_LENGTH,
  SNOWFLAKE_PATTERN,
  validateAiJob,
  validateAiSpendJob,
  validateReplyJob,
} from "./validate";

export const ENVELOPE_VERSION = 1;

export type EventSource = "interactions" | "gateway" | "worker";

export type EnvelopeOptions = {
  source: EventSource;
  guildId?: string;
};

const SPEND_EVENT_TYPE = "spend";

type ChatLikeKind = AiChatJob["kind"] | AiAskJob["kind"];

const CHAT_PAYLOAD_WHICH: Record<ChatLikeKind, EventEnvelope_Payload_Which> = {
  thread_start: EventEnvelope_Payload_Which.THREAD_START,
  thread_reply: EventEnvelope_Payload_Which.THREAD_REPLY,
  channel_reply: EventEnvelope_Payload_Which.CHANNEL_REPLY,
  ask: EventEnvelope_Payload_Which.ASK,
};

const optionalText = (value: string) => (value.length > 0 ? value : undefined);

const textListToArray = (list: capnp.List<string>): string[] =>
  Array.from({ length: list.length }, (_, index) => list.get(index));

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;

const initEnvelope = (
  message: capnp.Message,
  type: string,
  options: EnvelopeOptions,
  actor: { userId?: string; username?: string } = {},
) => {
  if (!isOptionalSnowflake(options.guildId)) {
    throw new Error("Invalid guild id for event envelope");
  }
  const envelope = message.initRoot(EventEnvelope);
  envelope.v = ENVELOPE_VERSION;
  envelope.type = type;
  envelope.id = crypto.randomUUID();
  envelope.occurredAt = new Date().toISOString();
  envelope.source = options.source;
  if (options.guildId !== undefined) {
    envelope.guildId = options.guildId;
  }
  if (actor.userId !== undefined) {
    envelope.actor.userId = actor.userId;
  }
  if (actor.username !== undefined) {
    envelope.actor.username = actor.username;
  }
  return envelope;
};

const initChatPayload = (envelope: EventEnvelope, kind: ChatLikeKind): ChatPayload => {
  switch (CHAT_PAYLOAD_WHICH[kind]) {
    case EventEnvelope_Payload_Which.THREAD_START:
      return envelope.payload._initThreadStart();
    case EventEnvelope_Payload_Which.THREAD_REPLY:
      return envelope.payload._initThreadReply();
    case EventEnvelope_Payload_Which.ASK:
      return envelope.payload._initAsk();
    default:
      return envelope.payload._initChannelReply();
  }
};

export const encodeAiJobEnvelope = (job: AiJob, options: EnvelopeOptions): Uint8Array => {
  if (!validateAiJob(job)) {
    throw new Error("Invalid AI job for event envelope");
  }

  const message = new capnp.Message();
  // message.received events carry the guild id and author on the job itself.
  const envelope = job.kind === "message.received"
    ? initEnvelope(
      message,
      job.kind,
      { ...options, guildId: job.guildId },
      { userId: job.authorId, username: job.authorUsername },
    )
    : initEnvelope(message, job.kind, options, {
      userId: job.requesterUserId,
      username: job.requesterUsername,
    });

  if (job.kind === "ragjam") {
    const payload = envelope.payload._initRagjam();
    payload.applicationId = job.applicationId;
    payload.interactionToken = job.interactionToken;
    if (job.channelId !== undefined) {
      payload.channelId = job.channelId;
    }
    payload.prompt = job.prompt;
    if (job.lyrics !== undefined) {
      payload.lyrics = job.lyrics;
    }
  } else if (job.kind === "bicture") {
    const payload = envelope.payload._initBicture();
    payload.applicationId = job.applicationId;
    payload.interactionToken = job.interactionToken;
    if (job.channelId !== undefined) {
      payload.channelId = job.channelId;
    }
    payload.prompt = job.prompt;
  } else if (job.kind === "message.received") {
    const payload = envelope.payload._initMessageReceived();
    payload.messageId = job.messageId;
    payload.channelId = job.channelId;
    payload.botUserId = job.botUserId;
    payload.content = job.content;
    const userIds = payload._initMentionUserIds(job.mentionUserIds.length);
    job.mentionUserIds.forEach((id, index) => userIds.set(index, id));
    const roleIds = payload._initMentionRoleIds(job.mentionRoleIds.length);
    job.mentionRoleIds.forEach((id, index) => roleIds.set(index, id));
    if (job.replyMessageId !== undefined) {
      payload.replyMessageId = job.replyMessageId;
    }
    if (job.replyChannelId !== undefined) {
      payload.replyChannelId = job.replyChannelId;
    }
  } else {
    const payload = initChatPayload(envelope, job.kind);
    payload.channelId = job.channelId;
    if (job.messageId !== undefined) {
      payload.messageId = job.messageId;
    }
    if (job.botUserId !== undefined) {
      payload.botUserId = job.botUserId;
    }
    payload.prompt = job.prompt;
    if (job.replyMessageId !== undefined) {
      payload.replyMessageId = job.replyMessageId;
    }
    if (job.replyChannelId !== undefined) {
      payload.replyChannelId = job.replyChannelId;
    }
  }

  return new Uint8Array(message.toArrayBuffer());
};

export const encodeReplyJobEnvelope = (job: ReplyJob, options: EnvelopeOptions): Uint8Array => {
  if (!validateReplyJob(job)) {
    throw new Error("Invalid reply job for event envelope");
  }

  const message = new capnp.Message();
  const envelope = initEnvelope(message, job.kind, options);
  if (job.kind === "reply.channel_message") {
    const payload = envelope.payload._initReplyChannelMessage();
    payload.channelId = job.channelId;
    payload.content = job.content;
  } else {
    const payload = envelope.payload._initReplyInteractionEdit();
    payload.applicationId = job.applicationId;
    payload.interactionToken = job.interactionToken;
    payload.content = job.content;
  }
  return new Uint8Array(message.toArrayBuffer());
};

export const encodeAiSpendJobEnvelope = (job: AiSpendJob, options: EnvelopeOptions): Uint8Array => {
  if (!validateAiSpendJob(job)) {
    throw new Error("Invalid AI spend job for event envelope");
  }

  const message = new capnp.Message();
  const envelope = initEnvelope(message, SPEND_EVENT_TYPE, options);
  envelope.payload._initSpend().spendEventId = job.spendEventId;
  return new Uint8Array(message.toArrayBuffer());
};

const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_ENVELOPE_SEGMENTS = 16;

// capnp-es sizes its segment list from the frame header before checking it
// against the actual buffer, so hostile bytes can demand huge allocations.
// Validate the unpacked framing ourselves before parsing.
const isSaneFramedMessage = (bytes: Uint8Array) => {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_ENVELOPE_BYTES || bytes.byteLength % 4 !== 0) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segmentCount = view.getUint32(0, true) + 1;
  if (segmentCount > MAX_ENVELOPE_SEGMENTS) {
    return false;
  }
  let byteOffset = 4 + segmentCount * 4;
  byteOffset += byteOffset % 8;
  if (byteOffset > bytes.byteLength) {
    return false;
  }
  for (let i = 0; i < segmentCount; i += 1) {
    byteOffset += view.getUint32(4 + i * 4, true) * 8;
    if (byteOffset > bytes.byteLength) {
      return false;
    }
  }
  return byteOffset === bytes.byteLength;
};

const readEnvelope = (value: unknown): EventEnvelope | null => {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;
  if (!bytes || !isSaneFramedMessage(bytes)) {
    return null;
  }
  try {
    const envelope = new capnp.Message(bytes, false).getRoot(EventEnvelope);
    if (envelope.v !== ENVELOPE_VERSION || !isOptionalSnowflake(optionalText(envelope.guildId))) {
      return null;
    }
    return envelope;
  } catch {
    return null;
  }
};

const chatJobFrom = (envelope: EventEnvelope, kind: ChatLikeKind, payload: ChatPayload) =>
  compact({
    kind,
    channelId: payload.channelId,
    messageId: optionalText(payload.messageId),
    botUserId: optionalText(payload.botUserId),
    requesterUserId: optionalText(envelope.actor.userId),
    requesterUsername: optionalText(envelope.actor.username),
    prompt: payload.prompt,
    replyMessageId: optionalText(payload.replyMessageId),
    replyChannelId: optionalText(payload.replyChannelId),
  });

const aiJobFrom = (envelope: EventEnvelope): unknown => {
  switch (envelope.payload.which()) {
    case EventEnvelope_Payload_Which.THREAD_START:
      return chatJobFrom(envelope, "thread_start", envelope.payload.threadStart);
    case EventEnvelope_Payload_Which.THREAD_REPLY:
      return chatJobFrom(envelope, "thread_reply", envelope.payload.threadReply);
    case EventEnvelope_Payload_Which.CHANNEL_REPLY:
      return chatJobFrom(envelope, "channel_reply", envelope.payload.channelReply);
    case EventEnvelope_Payload_Which.ASK:
      return chatJobFrom(envelope, "ask", envelope.payload.ask);
    case EventEnvelope_Payload_Which.RAGJAM: {
      const payload = envelope.payload.ragjam;
      const job: RagjamJob = compact({
        kind: "ragjam",
        applicationId: payload.applicationId,
        interactionToken: payload.interactionToken,
        channelId: optionalText(payload.channelId),
        requesterUserId: optionalText(envelope.actor.userId),
        requesterUsername: optionalText(envelope.actor.username),
        prompt: payload.prompt,
        lyrics: optionalText(payload.lyrics),
      });
      return job;
    }
    case EventEnvelope_Payload_Which.BICTURE: {
      const payload = envelope.payload.bicture;
      const job: BictureJob = compact({
        kind: "bicture",
        applicationId: payload.applicationId,
        interactionToken: payload.interactionToken,
        channelId: optionalText(payload.channelId),
        requesterUserId: optionalText(envelope.actor.userId),
        requesterUsername: optionalText(envelope.actor.username),
        prompt: payload.prompt,
      });
      return job;
    }
    case EventEnvelope_Payload_Which.MESSAGE_RECEIVED: {
      const payload = envelope.payload.messageReceived;
      const job: MessageReceivedJob = compact({
        kind: "message.received",
        messageId: payload.messageId,
        channelId: payload.channelId,
        guildId: optionalText(envelope.guildId),
        botUserId: payload.botUserId,
        authorId: optionalText(envelope.actor.userId),
        authorUsername: optionalText(envelope.actor.username),
        content: payload.content,
        mentionUserIds: textListToArray(payload.mentionUserIds),
        mentionRoleIds: textListToArray(payload.mentionRoleIds),
        replyMessageId: optionalText(payload.replyMessageId),
        replyChannelId: optionalText(payload.replyChannelId),
      });
      return job;
    }
    default:
      return null;
  }
};

export const decodeAiJobEnvelope = (bytes: unknown): AiJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    const job = aiJobFrom(envelope);
    return validateAiJob(job) && envelope.type === job.kind ? job : null;
  } catch {
    return null;
  }
};

const replyJobFrom = (envelope: EventEnvelope): ReplyJob | null => {
  switch (envelope.payload.which()) {
    case EventEnvelope_Payload_Which.REPLY_CHANNEL_MESSAGE: {
      const payload = envelope.payload.replyChannelMessage;
      return {
        kind: "reply.channel_message",
        channelId: payload.channelId,
        content: payload.content,
      };
    }
    case EventEnvelope_Payload_Which.REPLY_INTERACTION_EDIT: {
      const payload = envelope.payload.replyInteractionEdit;
      return {
        kind: "reply.interaction_edit",
        applicationId: payload.applicationId,
        interactionToken: payload.interactionToken,
        content: payload.content,
      };
    }
    default:
      return null;
  }
};

export const decodeReplyJobEnvelope = (bytes: unknown): ReplyJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    const job = replyJobFrom(envelope);
    return job && validateReplyJob(job) && envelope.type === job.kind ? job : null;
  } catch {
    return null;
  }
};

export const decodeAiSpendJobEnvelope = (bytes: unknown): AiSpendJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.SPEND) {
      return null;
    }
    const job: AiSpendJob = { spendEventId: envelope.payload.spend.spendEventId };
    return validateAiSpendJob(job) && envelope.type === SPEND_EVENT_TYPE ? job : null;
  } catch {
    return null;
  }
};
