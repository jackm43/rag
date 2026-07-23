// Minimal contracts for the ported bot library layer. This is the trimmed
// successor to packages/discord/contracts: it keeps ONLY the wire types,
// constants, and validators the ported REST/domain/AI modules actually use.
// The capnp envelope framing (encode/decode job envelopes) is intentionally
// dropped — the collapsed single worker calls these modules in-process, so
// there is no queue transport to frame for.

// --- validation primitives (copied from @rag/contracts-core) ---

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const isString = (value: unknown): value is string => typeof value === "string";

export const isSnowflake = (value: unknown): value is string =>
  isString(value) && SNOWFLAKE_PATTERN.test(value);

// --- constants ---

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export const MAX_DISCORD_MESSAGE_LENGTH = 1900;

// --- Discord wire types ---

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

// --- domain types ---

export type AiThread = {
  threadId: string;
  parentChannelId?: string;
  sourceMessageId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  initialPrompt: string;
  title: string;
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

export type AiChatJob = AiThreadStartJob | AiThreadReplyJob | AiChannelReplyJob;

// Media payload for a Discord interaction edit (image/audio generation output).
export type ResponderAttachment = {
  name: string;
  contentType: string;
  data: ArrayBuffer;
};

// --- Discord message validator (copied from contracts/discord.ts) ---

const isOptionalString = (value: unknown) => value === undefined || isString(value);
const isOptionalNullableString = (value: unknown) =>
  value === undefined || value === null || isString(value);

const hasOnlyStringValues = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every(isString));

const isDiscordUser = (value: unknown) => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isString(value.id) &&
    isString(value.username) &&
    isOptionalNullableString(value.global_name) &&
    (value.bot === undefined || typeof value.bot === "boolean")
  );
};

const isDiscordMember = (value: unknown) => {
  if (!isRecord(value)) {
    return false;
  }
  return isOptionalNullableString(value.nick) && (value.user === undefined || isDiscordUser(value.user));
};

const isDiscordMention = (value: unknown) =>
  isRecord(value) && isString(value.id) && isOptionalString(value.username);

const isDiscordAttachment = (value: unknown) =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.filename) &&
  isOptionalString(value.content_type) &&
  isOptionalString(value.url);

const isMessageReference = (value: unknown) =>
  value === undefined ||
  (isRecord(value) && isOptionalString(value.channel_id) && isOptionalString(value.message_id));

const isDiscordMessageAtDepth = (value: unknown, depth: number): value is DiscordMessage => {
  if (!isRecord(value) || !isString(value.id) || !isString(value.channel_id)) {
    return false;
  }
  return (
    isOptionalString(value.guild_id) &&
    isOptionalString(value.content) &&
    (value.author === undefined || isDiscordUser(value.author)) &&
    (value.member === undefined || isDiscordMember(value.member)) &&
    (value.mentions === undefined || (Array.isArray(value.mentions) && value.mentions.every(isDiscordMention))) &&
    hasOnlyStringValues(value.mention_roles) &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) && value.attachments.every(isDiscordAttachment))) &&
    isMessageReference(value.message_reference) &&
    (value.referenced_message === undefined ||
      value.referenced_message === null ||
      (depth > 0 && isDiscordMessageAtDepth(value.referenced_message, depth - 1)))
  );
};

export const isDiscordMessage = (value: unknown): value is DiscordMessage =>
  isDiscordMessageAtDepth(value, 1);
