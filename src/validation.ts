import type {
  APIChatInputApplicationCommandInteraction,
  APIMessage,
  APIPingInteraction,
  APIUser,
} from "discord-api-types/payloads/v10";
import type { GatewayMessageCreateDispatchData } from "discord-api-types/gateway/v10";

import type { AiJob } from "./types";

type DiscordMessage = APIMessage | GatewayMessageCreateDispatchData;

const DISCORD_INTERACTION_PING = 1;
const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;

const objectFrom = (value: unknown) =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
const isString = (value: unknown): value is string => typeof value === "string";
const isOptionalString = (value: unknown) => value === undefined || isString(value);
const isOptionalNullableString = (value: unknown) =>
  value === undefined || value === null || isString(value);

const hasOnlyStringValues = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every(isString));

const isDiscordUser = (value: unknown): value is APIUser => {
  const user = objectFrom(value);
  if (!user) {
    return false;
  }

  return (
    isString(user.id) &&
    isString(user.username) &&
    isOptionalNullableString(user.global_name) &&
    (user.bot === undefined || typeof user.bot === "boolean")
  );
};

const isDiscordMember = (value: unknown) => {
  const member = objectFrom(value);
  if (!member) {
    return false;
  }

  return (
    isOptionalNullableString(member.nick) &&
    hasOnlyStringValues(member.roles) &&
    (member.user === undefined || isDiscordUser(member.user))
  );
};

const isResolvedUsers = (value: unknown) => {
  const users = objectFrom(value);
  return value === undefined || (users !== null && Object.values(users).every(isDiscordUser));
};

const isResolvedMembers = (value: unknown) => {
  const members = objectFrom(value);
  return value === undefined || (members !== null && Object.values(members).every(isDiscordMember));
};

const isInteractionResolved = (value: unknown) => {
  if (value === undefined) {
    return true;
  }
  const resolved = objectFrom(value);
  if (!resolved) {
    return false;
  }

  return isResolvedUsers(resolved.users) && isResolvedMembers(resolved.members);
};

const isInteractionOption = (value: unknown) => {
  const option = objectFrom(value);
  if (!option || !isString(option.name)) {
    return false;
  }

  return (
    isString(option.value) ||
    typeof option.value === "number" ||
    typeof option.value === "boolean" ||
    (option.value === undefined &&
      option.options !== undefined &&
      Array.isArray(option.options) &&
      option.options.every(isInteractionOption))
  );
};

const isInteractionData = (value: unknown) => {
  const data = objectFrom(value);
  if (!data) {
    return false;
  }

  return (
    isString(data.name) &&
    (data.options === undefined || (Array.isArray(data.options) && data.options.every(isInteractionOption))) &&
    isInteractionResolved(data.resolved)
  );
};

export const isDiscordInteraction = (
  value: unknown,
): value is APIPingInteraction | APIChatInputApplicationCommandInteraction => {
  const interaction = objectFrom(value);
  if (!interaction || typeof interaction.type !== "number") {
    return false;
  }

  if (interaction.type === DISCORD_INTERACTION_PING) {
    return true;
  }

  if (interaction.type !== DISCORD_INTERACTION_APPLICATION_COMMAND) {
    return false;
  }

  return (
    isOptionalString(interaction.application_id) &&
    isOptionalString(interaction.channel_id) &&
    isOptionalString(interaction.guild_id) &&
    isOptionalString(interaction.token) &&
    isInteractionData(interaction.data) &&
    (interaction.user === undefined || isDiscordUser(interaction.user)) &&
    (interaction.member === undefined || isDiscordMember(interaction.member))
  );
};

const isDiscordMention = (value: unknown) => {
  const mention = objectFrom(value);
  return mention !== null && isString(mention.id) && isOptionalString(mention.username);
};

const isDiscordAttachment = (value: unknown) => {
  const attachment = objectFrom(value);
  return (
    attachment !== null &&
    isString(attachment.id) &&
    isString(attachment.filename) &&
    isOptionalString(attachment.content_type) &&
    isOptionalString(attachment.url)
  );
};

const isMessageReference = (value: unknown) => {
  if (value === undefined) {
    return true;
  }
  const reference = objectFrom(value);
  return reference !== null && isOptionalString(reference.channel_id) && isOptionalString(reference.message_id);
};

const isDiscordMessageAtDepth = (value: unknown, depth: number): value is DiscordMessage => {
  const message = objectFrom(value);
  if (!message || !isString(message.id) || !isString(message.channel_id)) {
    return false;
  }

  return (
    isOptionalString(message.guild_id) &&
    isOptionalString(message.content) &&
    (message.author === undefined || isDiscordUser(message.author)) &&
    (message.member === undefined || isDiscordMember(message.member)) &&
    (message.mentions === undefined || (Array.isArray(message.mentions) && message.mentions.every(isDiscordMention))) &&
    hasOnlyStringValues(message.mention_roles) &&
    (message.attachments === undefined ||
      (Array.isArray(message.attachments) && message.attachments.every(isDiscordAttachment))) &&
    isMessageReference(message.message_reference) &&
    (message.referenced_message === undefined ||
      message.referenced_message === null ||
      (depth > 0 && isDiscordMessageAtDepth(message.referenced_message, depth - 1)))
  );
};

export const isDiscordMessage = (value: unknown): value is DiscordMessage =>
  isDiscordMessageAtDepth(value, 1);

const isOptionalJobString = (value: unknown) => value === undefined || isString(value);

export const isAiJob = (value: unknown): value is AiJob => {
  const job = objectFrom(value);
  if (
    !job ||
    (job.kind !== "thread_start" && job.kind !== "thread_reply" && job.kind !== "channel_reply")
  ) {
    return false;
  }

  const common =
    isString(job.channelId) &&
    isString(job.prompt) &&
    isOptionalJobString(job.botUserId) &&
    isOptionalJobString(job.requesterUserId) &&
    isOptionalJobString(job.requesterUsername) &&
    isOptionalJobString(job.replyMessageId) &&
    isOptionalJobString(job.replyChannelId);

  if (!common) {
    return false;
  }

  if (job.kind === "thread_start") {
    return isString(job.messageId);
  }

  return isOptionalJobString(job.messageId);
};
