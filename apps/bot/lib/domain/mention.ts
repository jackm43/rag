import { SYSTEM_SUBJECT } from "@rag/service-kit";
import { MAX_MENTION_IDS } from "../../contracts";
import { isSnowflake, MAX_FREE_TEXT_LENGTH } from "@rag/contracts-core";
import { fetchBotRoleIds } from "../discord";
import { activeAiBanForUser } from "./bans";
import { isGuildAllowed } from "./guilds";
import { checkAiUsageAllowed } from "./limits";
import { errorMessage, logger } from "@rag/logger";
import { sendChannelReply } from "./outbox";
import { findAiThread } from "./threads";
import type { AiChatJob, DiscordMessage, Env, MessageReceivedJob } from "../../contracts";

export type ChannelPromptMessage = Pick<DiscordMessage, "content" | "mentions" | "mention_roles">;

const mentionTokens = (content: string) => [...content.matchAll(/<@([!&]?)([^>\s]+)>/g)];

export const stripMentionTokens = (content: string) =>
  content
    .replace(/<@[!&]?[^>\s]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const messageMentionsBot = (
  message: ChannelPromptMessage,
  botUserId: string,
  applicationId?: string,
  botRoleIds?: readonly string[],
) => {
  const content = message.content ?? "";
  const userIds = new Set((message.mentions ?? []).map((mention) => String(mention.id)));
  const roleIds = new Set((message.mention_roles ?? []).map(String));
  for (const [, marker, id] of mentionTokens(content)) {
    (marker === "&" ? roleIds : userIds).add(id);
  }
  if (userIds.has(botUserId) || (applicationId !== undefined && userIds.has(applicationId))) {
    return true;
  }
  return (botRoleIds ?? []).some((id) => roleIds.has(id));
};

export const extractBotMentionPrompt = (
  content: string,
  botUserId: string,
  applicationId?: string,
) => {
  if (!messageMentionsBot({ content }, botUserId, applicationId)) {
    return null;
  }
  const prompt = stripMentionTokens(content);
  return prompt.length > 0 ? prompt : null;
};

const resolveChannelPrompt = (
  message: ChannelPromptMessage,
  botUserId: string,
  applicationId?: string,
  botRoleIds?: readonly string[],
) => {
  if (!messageMentionsBot(message, botUserId, applicationId, botRoleIds)) {
    return null;
  }
  const prompt = stripMentionTokens(message.content ?? "");
  return prompt.length > 0 ? prompt : null;
};

export const getMessageAuthorDisplayName = (message: DiscordMessage) =>
  message.member?.nick?.trim() ||
  message.author?.global_name?.trim() ||
  message.author?.username?.trim() ||
  "user";

const snowflakesOnly = (ids: Iterable<string>) =>
  [...new Set(ids)].filter((id) => isSnowflake(id)).slice(0, MAX_MENTION_IDS);

// Pure translation of a validated gateway MESSAGE_CREATE into the encoded
// event the Durable Object enqueues. No D1, no Discord REST.
const gatewayMessageJob = (message: DiscordMessage, botUserId: string): MessageReceivedJob => ({
  kind: "message.received",
  messageId: message.id,
  channelId: message.channel_id,
  ...(message.guild_id !== undefined ? { guildId: message.guild_id } : {}),
  botUserId,
  ...(message.author?.id !== undefined ? { authorId: message.author.id } : {}),
  authorUsername: getMessageAuthorDisplayName(message),
  content: (message.content ?? "").slice(0, MAX_FREE_TEXT_LENGTH),
  mentionUserIds: snowflakesOnly((message.mentions ?? []).map((mention) => String(mention.id))),
  mentionRoleIds: snowflakesOnly((message.mention_roles ?? []).map(String)),
  ...(message.message_reference?.message_id ?? message.referenced_message?.id
    ? { replyMessageId: message.message_reference?.message_id ?? message.referenced_message?.id }
    : {}),
  ...(message.message_reference?.channel_id ?? message.referenced_message?.channel_id
    ? { replyChannelId: message.message_reference?.channel_id ?? message.referenced_message?.channel_id }
    : {}),
});

// Gateway websocket entry point: validate → kick the processor DO, nothing
// else. The InteractionSession DO is addressed by idFromName(message.id), so its
// claim() is the single, DURABLE idempotency authority — a MESSAGE_CREATE that
// Discord redelivers on a reconnect/resume reaches the same DO and is dropped,
// however long after the first delivery (the old 60s gateway dedupe could not
// span a reconnect gap and produced double replies). Whether a message is
// actually relevant can depend on D1 thread tracking the gateway cannot see, so
// every non-bot message with a usable prompt is forwarded and the DO resolves +
// filters. The only pre-filters are pure and local: skip bots, non-allowed
// guilds (and DMs), and empty prompts after mention stripping.
export const handleGatewayMessageCreate = async (
  message: DiscordMessage,
  env: Env,
  botUserId: string | null,
) => {
  if (message.author?.bot || !botUserId) {
    return;
  }

  if (!isGuildAllowed(env, message.guild_id)) {
    return;
  }

  if (!stripMentionTokens(message.content ?? "")) {
    return;
  }

  await env.INTERACTION_SESSION
    .get(env.INTERACTION_SESSION.idFromName(message.id))
    .runMention(gatewayMessageJob(message, botUserId));
};

// Workflows-side resolution: everything the DO used to do that needs D1 or
// Discord REST. Returns the chat job to process in-process, or null when the
// message is irrelevant or denied (denial notices leave via the outbox).
export const resolveGatewayMessage = async (
  job: MessageReceivedJob,
  env: Env,
): Promise<AiChatJob | null> => {
  // Defense in depth: the Durable Object already gates on the guild
  // allowlist before enqueueing, but queue hops are zero-trust.
  if (!isGuildAllowed(env, job.guildId)) {
    return null;
  }

  const existingThread = job.guildId ? await findAiThread(env, job.channelId) : null;
  if (existingThread) {
    const prompt = stripMentionTokens(job.content);
    if (!prompt) {
      return null;
    }

    if (!(await gatewayUsageAllowed(job, env, "thread_reply"))) {
      return null;
    }

    return {
      kind: "thread_reply",
      channelId: job.channelId,
      messageId: job.messageId,
      botUserId: job.botUserId,
      requesterUserId: job.authorId,
      requesterUsername: job.authorUsername,
      prompt,
      replyMessageId: job.replyMessageId,
      replyChannelId: job.replyChannelId,
    };
  }

  let botRoleIds: string[] = [];
  if (job.mentionRoleIds.length > 0 && job.guildId) {
    botRoleIds = await fetchBotRoleIds(env, "workflows", job.guildId, job.botUserId);
  }

  const prompt = resolveChannelPrompt(
    {
      content: job.content,
      mentions: job.mentionUserIds.map((id) => ({ id })),
      mention_roles: job.mentionRoleIds,
    },
    job.botUserId,
    env.DISCORD_APPLICATION_ID,
    botRoleIds,
  );
  if (!prompt) {
    return null;
  }

  if (!(await gatewayUsageAllowed(job, env, "channel_reply"))) {
    return null;
  }

  return {
    kind: "channel_reply",
    channelId: job.channelId,
    messageId: job.messageId,
    botUserId: job.botUserId,
    requesterUserId: job.authorId,
    requesterUsername: job.authorUsername,
    prompt,
    replyMessageId: job.replyMessageId,
    replyChannelId: job.replyChannelId,
  };
};

const gatewayUsageAllowed = async (job: MessageReceivedJob, env: Env, kind: string) => {
  // raghammer bans cover gateway AI too: mentions and tracked-thread replies
  // from banned users are ignored outright (no notice).
  if (job.authorId && (await activeAiBanForUser(env, job.authorId, new Date()))) {
    return false;
  }

  const usage = await checkAiUsageAllowed(env, job.authorId, kind);
  if (usage.allowed) {
    return true;
  }

  await sendChannelReply(env, job.channelId, usage.message, job.authorId ?? SYSTEM_SUBJECT).catch((error) => {
    logger.warn("ai_usage_denial_notice_failed", { error: errorMessage(error) });
  });
  return false;
};
