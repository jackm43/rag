// Bot-owned message contracts: AI jobs, reply/spend jobs, and the Discord
// wire types the gateway and downstream bot workers share. The envelope
// kernel (framing, transport, validation primitives) is @rag/contracts-core.
import * as capnp from "capnp-es";
import {
  compact,
  initEnvelope,
  isCappedText,
  isFreeText,
  isInteractionToken,
  isOptionalFreeText,
  isOptionalSnowflake,
  isOptionalUsername,
  isRecord,
  isSnowflake,
  isString,
  MAX_FREE_TEXT_LENGTH,
  optionalText,
  readEnvelope,
  textListToArray,
  type EnvelopeOptions,
} from "@rag/contracts-core";
import {
  EventEnvelope_Payload_Which,
  type ChatPayload,
  type EventEnvelope,
} from "@rag/contracts-core/envelope";
import type { AuthEnv } from "@rag/auth-kit/env";
import type { SecretsEnv } from "@rag/secrets/env";
import type { ServiceKitEnv } from "@rag/service-kit/env";

export * from "./discord";

export type DiscordInteraction = {
  application_id?: string;
  channel_id?: string;
  guild_id?: string;
  token?: string;
  type: number;
  data?: {
    name?: string;
    options?: Array<{ name: string; value: string | number | boolean }>;
    resolved?: {
      users?: Record<string, { id: string; username: string; global_name?: string | null }>;
      members?: Record<string, { nick?: string | null }>;
    };
  };
  user?: { id: string; username: string; global_name?: string | null };
  member?: {
    nick?: string | null;
    user?: { id: string; username: string; global_name?: string | null };
  };
  resolved?: {
    users?: Record<string, { id: string; username: string; global_name?: string | null }>;
    members?: Record<string, { nick?: string | null }>;
  };
};

export type AiThreadStartJob = {
  kind: "thread_start";
  channelId: string;
  messageId: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  replyMessageId?: string;
  replyChannelId?: string;
};

export type AiThreadReplyJob = {
  kind: "thread_reply";
  channelId: string;
  messageId?: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  replyMessageId?: string;
  replyChannelId?: string;
};

export type AiChannelReplyJob = {
  kind: "channel_reply";
  channelId: string;
  messageId?: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  replyMessageId?: string;
  replyChannelId?: string;
};

export type AiAskJob = {
  kind: "ask";
  channelId: string;
  messageId?: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  replyMessageId?: string;
  replyChannelId?: string;
};

export type RagjamJob = {
  kind: "ragjam";
  applicationId: string;
  interactionToken: string;
  channelId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  lyrics?: string;
};

// A raw-but-validated gateway MESSAGE_CREATE, encoded by the Durable Object
// with no D1 or Discord REST access. The workflows worker resolves it into a
// thread_reply/channel_reply (or drops it) in-process.
export type MessageReceivedJob = {
  kind: "message.received";
  messageId: string;
  channelId: string;
  guildId?: string;
  botUserId: string;
  authorId?: string;
  authorUsername?: string;
  content: string;
  mentionUserIds: string[];
  mentionRoleIds: string[];
  replyMessageId?: string;
  replyChannelId?: string;
};

export type BictureJob = {
  kind: "bicture";
  applicationId: string;
  interactionToken: string;
  channelId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
};

export type AiChatJob = AiThreadStartJob | AiThreadReplyJob | AiChannelReplyJob;

export type AiJob = AiChatJob | AiAskJob | RagjamJob | BictureJob | MessageReceivedJob;

export type AiSpendJob = {
  spendEventId: string;
};

export type ChannelMessageReplyJob = {
  kind: "reply.channel_message";
  channelId: string;
  content: string;
};

export type InteractionEditReplyJob = {
  kind: "reply.interaction_edit";
  applicationId: string;
  interactionToken: string;
  content: string;
};

export type ReplyJob = ChannelMessageReplyJob | InteractionEditReplyJob;

export type ResponderAttachment = {
  name: string;
  contentType: string;
  data: ArrayBuffer;
};

export type AiThread = {
  threadId: string;
  parentChannelId?: string;
  sourceMessageId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  initialPrompt: string;
  title: string;
};

export type DiscordMessage = {
  id: string;
  guild_id?: string;
  channel_id: string;
  content?: string;
  author?: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: {
    nick?: string | null;
  };
  mentions?: Array<{ id: string; username?: string }>;
  mention_roles?: string[];
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string;
    url?: string;
  }>;
  message_reference?: {
    channel_id?: string;
    message_id?: string;
  };
  referenced_message?: DiscordMessage | null;
};

export type DiscordChannel = {
  id: string;
  type: number;
  parent_id?: string | null;
  name?: string;
  thread_metadata?: Record<string, unknown>;
};

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export const MAX_DISCORD_MESSAGE_LENGTH = 1900;

export const PING = 1;
export const APPLICATION_COMMAND = 2;
export const CHANNEL_MESSAGE_WITH_SOURCE = 4;
export const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

// The bot's own bindings; the composed Env below is what bot worker code sees.
export type BotEnv = {
  // The gateway independently enforces the dev-proxy's acting-subject
  // allowlist (fail closed); the dev-proxy carries its own copy in
  // ConnectorsEnv.
  DEV_PROXY_ALLOWED_SUBJECTS?: string;
  AI_JOBS: Queue<Uint8Array>;
  SPEND_JOBS?: Queue<Uint8Array>;
  DISCORD_OUTBOX?: Queue<Uint8Array>;
  RESPONDER?: {
    deliverInteractionEdit: (
      message: Uint8Array,
      attachment: ResponderAttachment,
    ) => Promise<void>;
  };
  // InteractionSession Durable Object (defined in the workflows worker). Typed
  // structurally like SERVICE_REGISTRY so contracts stays leaf. Both ingresses
  // bind it cross-script and kick it: the webhooks ingress via run() (full
  // deferred dispatch), the gateway via runDeferredCommand() (legacy path). It
  // edits the response as `workflows`; the workflows worker hosts it locally.
  INTERACTION_SESSION: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      run: (interaction: DiscordInteraction) => Promise<void>;
      runMention: (job: MessageReceivedJob) => Promise<void>;
      runDeferredCommand: (interaction: DiscordInteraction, commandName: string) => Promise<void>;
    };
  };
  CLOUDFLARE_API_TOKEN?: string;
  CF_AIG_GATEWAY_ID?: string;
  ALLOWED_GUILD_IDS?: string;
  AI_BURST_LIMIT_PER_MINUTE?: string;
  AI_GLOBAL_DAILY_BUDGET_USD?: string;
  // Workers KV holding the AI prompt/config files, bound on the workflows worker
  // only (the sole runtime AI consumer). loadConfig reads it with a bundled
  // fallback, so it is optional — a fresh namespace or KV outage still works.
  AI_CONFIG?: KVNamespace;
};

export type Env = Cloudflare.Env & ServiceKitEnv & AuthEnv & SecretsEnv & BotEnv;

export const MAX_SPEND_EVENT_ID_LENGTH = 128;
// Raw model text crossing the outbox before the responder applies the final
// Discord length policy. Queue messages are capped at 128 KiB, so keep this
// far below that even at four bytes per character.
export const MAX_REPLY_CONTENT_LENGTH = 16_000;
// Discord messages carry at most ~100 user/role mentions.
export const MAX_MENTION_IDS = 100;

const isSnowflakeList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_MENTION_IDS && value.every(isSnowflake);

export const validateAiJob = (value: unknown): value is AiJob => {
  if (
    !isRecord(value) ||
    (
      value.kind !== "thread_start" &&
      value.kind !== "thread_reply" &&
      value.kind !== "channel_reply" &&
      value.kind !== "ask" &&
      value.kind !== "ragjam" &&
      value.kind !== "bicture" &&
      value.kind !== "message.received"
    )
  ) {
    return false;
  }

  if (value.kind === "message.received") {
    return (
      isSnowflake(value.messageId) &&
      isSnowflake(value.channelId) &&
      isSnowflake(value.botUserId) &&
      isOptionalSnowflake(value.guildId) &&
      isOptionalSnowflake(value.authorId) &&
      isOptionalUsername(value.authorUsername) &&
      isCappedText(value.content) &&
      isSnowflakeList(value.mentionUserIds) &&
      isSnowflakeList(value.mentionRoleIds) &&
      isOptionalSnowflake(value.replyMessageId) &&
      isOptionalSnowflake(value.replyChannelId)
    );
  }

  if (value.kind === "bicture") {
    return (
      isSnowflake(value.applicationId) &&
      isInteractionToken(value.interactionToken) &&
      isFreeText(value.prompt) &&
      isOptionalSnowflake(value.channelId) &&
      isOptionalSnowflake(value.requesterUserId) &&
      isOptionalUsername(value.requesterUsername)
    );
  }

  if (value.kind === "ragjam") {
    return (
      isSnowflake(value.applicationId) &&
      isInteractionToken(value.interactionToken) &&
      isFreeText(value.prompt) &&
      isOptionalSnowflake(value.channelId) &&
      isOptionalSnowflake(value.requesterUserId) &&
      isOptionalUsername(value.requesterUsername) &&
      isOptionalFreeText(value.lyrics)
    );
  }

  const common =
    isSnowflake(value.channelId) &&
    isFreeText(value.prompt) &&
    isOptionalSnowflake(value.botUserId) &&
    isOptionalSnowflake(value.requesterUserId) &&
    isOptionalUsername(value.requesterUsername) &&
    isOptionalSnowflake(value.replyMessageId) &&
    isOptionalSnowflake(value.replyChannelId);

  if (!common) {
    return false;
  }

  if (value.kind === "thread_start") {
    return isSnowflake(value.messageId);
  }

  return isOptionalSnowflake(value.messageId);
};

// Reply content may be empty: the responder substitutes its own fallback text.
const isReplyContent = (value: unknown): value is string =>
  isString(value) && value.length <= MAX_REPLY_CONTENT_LENGTH;

export const validateReplyJob = (value: unknown): value is ReplyJob => {
  if (!isRecord(value)) {
    return false;
  }

  if (value.kind === "reply.channel_message") {
    return isSnowflake(value.channelId) && isReplyContent(value.content);
  }

  if (value.kind === "reply.interaction_edit") {
    return (
      isSnowflake(value.applicationId) &&
      isInteractionToken(value.interactionToken) &&
      isReplyContent(value.content)
    );
  }

  return false;
};

export const validateAiSpendJob = (value: unknown): value is AiSpendJob =>
  isRecord(value) &&
  isString(value.spendEventId) &&
  value.spendEventId.length > 0 &&
  value.spendEventId.length <= MAX_SPEND_EVENT_ID_LENGTH;

const SPEND_EVENT_TYPE = "spend";

type ChatLikeKind = AiChatJob["kind"] | AiAskJob["kind"];

const CHAT_PAYLOAD_WHICH: Record<ChatLikeKind, EventEnvelope_Payload_Which> = {
  thread_start: EventEnvelope_Payload_Which.THREAD_START,
  thread_reply: EventEnvelope_Payload_Which.THREAD_REPLY,
  channel_reply: EventEnvelope_Payload_Which.CHANNEL_REPLY,
  ask: EventEnvelope_Payload_Which.ASK,
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
