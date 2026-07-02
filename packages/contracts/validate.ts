import type { AiJob, AiSpendJob, ReplyJob } from "./types";
import { isRecord } from "./validation";

// Value constraints the Cap'n Proto schema cannot express. Applied at encode
// (producer) and decode (consumer) time so neither side trusts the other hop.
export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
export const MAX_FREE_TEXT_LENGTH = 4000;
export const MAX_USERNAME_LENGTH = 100;
export const MAX_INTERACTION_TOKEN_LENGTH = 2000;
export const MAX_SPEND_EVENT_ID_LENGTH = 128;
// Raw model text crossing the outbox before the responder applies the final
// Discord length policy. Queue messages are capped at 128 KiB, so keep this
// far below that even at four bytes per character.
export const MAX_REPLY_CONTENT_LENGTH = 16_000;
// Discord messages carry at most ~100 user/role mentions.
export const MAX_MENTION_IDS = 100;

const isString = (value: unknown): value is string => typeof value === "string";

export const isSnowflake = (value: unknown): value is string =>
  isString(value) && SNOWFLAKE_PATTERN.test(value);

export const isOptionalSnowflake = (value: unknown) => value === undefined || isSnowflake(value);

const isFreeText = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.length <= MAX_FREE_TEXT_LENGTH;

const isOptionalFreeText = (value: unknown) => value === undefined || isFreeText(value);

const isUsername = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.length <= MAX_USERNAME_LENGTH;

const isOptionalUsername = (value: unknown) => value === undefined || isUsername(value);

const isInteractionToken = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.length <= MAX_INTERACTION_TOKEN_LENGTH;

// Gateway message content may be empty (e.g. attachment-only messages); the
// brain drops anything that resolves to an empty prompt.
const isCappedText = (value: unknown): value is string =>
  isString(value) && value.length <= MAX_FREE_TEXT_LENGTH;

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
