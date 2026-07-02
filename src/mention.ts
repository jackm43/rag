import { fetchBotRoleIds, postChannelMessage } from "./discord";
import { checkAiUsageAllowed } from "./limits";
import { errorMessage, logger } from "./logger";
import { findAiThread } from "./threads";
import type { DiscordMessage, Env } from "./types";

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

export const handleGatewayMessageCreate = async (
  message: DiscordMessage,
  env: Env,
  botUserId: string | null,
) => {
  if (message.author?.bot || !botUserId) {
    return;
  }

  const replyMessageId = message.message_reference?.message_id ?? message.referenced_message?.id;
  const replyChannelId =
    message.message_reference?.channel_id ?? message.referenced_message?.channel_id;
  const requesterUsername = getMessageAuthorDisplayName(message);

  const existingThread = message.guild_id ? await findAiThread(env, message.channel_id) : null;
  if (existingThread) {
    const prompt = stripMentionTokens(message.content ?? "");
    if (!prompt) {
      return;
    }

    const usage = await checkAiUsageAllowed(env, message.author?.id, "thread_reply");
    if (!usage.allowed) {
      await postChannelMessage(env, message.channel_id, usage.message).catch((error) => {
        logger.warn("ai_usage_denial_notice_failed", { error: errorMessage(error) });
      });
      return;
    }

    await env.AI_JOBS.send({
      kind: "thread_reply",
      channelId: message.channel_id,
      messageId: message.id,
      botUserId,
      requesterUserId: message.author?.id,
      requesterUsername,
      prompt,
      replyMessageId,
      replyChannelId,
    });
    return;
  }

  let botRoleIds: string[] = [];
  if (message.mention_roles?.length && message.guild_id) {
    botRoleIds = await fetchBotRoleIds(env, message.guild_id, botUserId);
  }

  const prompt = resolveChannelPrompt(message, botUserId, env.DISCORD_APPLICATION_ID, botRoleIds);
  if (!prompt) {
    return;
  }

  const usage = await checkAiUsageAllowed(env, message.author?.id, "channel_reply");
  if (!usage.allowed) {
    await postChannelMessage(env, message.channel_id, usage.message).catch((error) => {
      logger.warn("ai_usage_denial_notice_failed", { error: errorMessage(error) });
    });
    return;
  }

  await env.AI_JOBS.send({
    kind: "channel_reply",
    channelId: message.channel_id,
    messageId: message.id,
    botUserId,
    requesterUserId: message.author?.id,
    requesterUsername,
    prompt,
    replyMessageId,
    replyChannelId,
  });
};
