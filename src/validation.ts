import type { AiJob, DiscordInteraction, DiscordMessage } from "./types";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";
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

const isResolvedUsers = (value: unknown) =>
  value === undefined || (isRecord(value) && Object.values(value).every(isDiscordUser));

const isResolvedMembers = (value: unknown) =>
  value === undefined || (isRecord(value) && Object.values(value).every(isDiscordMember));

const isInteractionResolved = (value: unknown) => {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }

  return isResolvedUsers(value.users) && isResolvedMembers(value.members);
};

const isInteractionOption = (value: unknown) =>
  isRecord(value) &&
  isString(value.name) &&
  (isString(value.value) || typeof value.value === "number" || typeof value.value === "boolean");

const isInteractionData = (value: unknown) => {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptionalString(value.name) &&
    (value.options === undefined || (Array.isArray(value.options) && value.options.every(isInteractionOption))) &&
    isInteractionResolved(value.resolved)
  );
};

export const isDiscordInteraction = (value: unknown): value is DiscordInteraction => {
  if (!isRecord(value) || typeof value.type !== "number") {
    return false;
  }

  return (
    isOptionalString(value.application_id) &&
    isOptionalString(value.channel_id) &&
    isOptionalString(value.guild_id) &&
    isOptionalString(value.token) &&
    isInteractionData(value.data) &&
    (value.user === undefined || isDiscordUser(value.user)) &&
    (value.member === undefined || isDiscordMember(value.member)) &&
    isInteractionResolved(value.resolved)
  );
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

const isOptionalJobString = (value: unknown) => value === undefined || isString(value);

export const isAiJob = (value: unknown): value is AiJob => {
  if (
    !isRecord(value) ||
    (value.kind !== "thread_start" && value.kind !== "thread_reply" && value.kind !== "channel_reply")
  ) {
    return false;
  }

  const common =
    isString(value.channelId) &&
    isString(value.prompt) &&
    isOptionalJobString(value.botUserId) &&
    isOptionalJobString(value.requesterUserId) &&
    isOptionalJobString(value.requesterUsername) &&
    isOptionalJobString(value.replyMessageId) &&
    isOptionalJobString(value.replyChannelId);

  if (!common) {
    return false;
  }

  if (value.kind === "thread_start") {
    return isString(value.messageId);
  }

  return isOptionalJobString(value.messageId);
};
