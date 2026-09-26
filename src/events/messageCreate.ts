import { runAskModeCompletion } from "../lib/ai/ask-mode";
import { deliverAiReply } from "../lib/ai/reply";
import { runTrackedChatCompletion } from "../lib/ai/tracked-ai";
import { activeAiBanForUser } from "../lib/db/bans";
import { buildNormalThreadConversation, isAskThread } from "../lib/db/conversation";
import { isGuildAllowed } from "../lib/db/guilds";
import { checkAiUsageAllowed } from "../lib/db/limits";
import { getMessageAuthorDisplayName, stripMentionTokens } from "../lib/db/mention";
import { findAiThread } from "../lib/db/threads";
import { fetchBotRoleIds, sendChannelReply } from "../lib/discord";
import { isSnowflake, type AiChatJob, type DiscordMessage } from "../lib/contracts";
import { errorMessage, logger } from "../lib/logger";
import type { Env } from "../env";

export { stripMentionTokens } from "../lib/db/mention";

// Ported from packages/discord/domain/mention.ts + the channel_reply/thread_reply
// branches of packages/discord/domain/consumer.ts. In the collapsed worker the
// gateway Durable Object calls handleMessageCreate in-process (no queue hop, no
// InteractionSession DO): pre-filter, resolve against D1/Discord, then run the
// model call and post the reply.

const MAX_MENTION_IDS = 100;
const MAX_FREE_TEXT_LENGTH = 4000;

// Intermediate shape between the raw gateway MESSAGE_CREATE and the resolved
// AiChatJob. Kept as a discrete type so resolveGatewayMessage stays unit-testable
// in isolation (the old MessageReceivedJob, minus the queue envelope framing).
export type GatewayMessageJob = {
  kind: "message.received";
  messageId: string;
  channelId: string;
  guildId?: string;
  botUserId: string;
  authorId?: string;
  authorUsername: string;
  content: string;
  mentionUserIds: string[];
  mentionRoleIds: string[];
  replyMessageId?: string;
  replyChannelId?: string;
};

type ChannelPromptMessage = Pick<DiscordMessage, "content" | "mentions" | "mention_roles">;

const mentionTokens = (content: string) => [...content.matchAll(/<@([!&]?)([^>\s]+)>/g)];

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

const snowflakesOnly = (ids: Iterable<string>) =>
  [...new Set(ids)].filter((id) => isSnowflake(id)).slice(0, MAX_MENTION_IDS);

// Pure translation of a validated gateway MESSAGE_CREATE into the intermediate
// job the resolver consumes. No D1, no Discord REST.
const gatewayMessageJob = (message: DiscordMessage, botUserId: string): GatewayMessageJob => ({
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

const gatewayUsageAllowed = async (job: GatewayMessageJob, env: Env, kind: string) => {
  // raghammer bans cover gateway AI too: mentions and tracked-thread replies
  // from banned users are ignored outright (no notice).
  if (job.authorId && (await activeAiBanForUser(env, job.authorId, new Date()))) {
    return false;
  }

  const usage = await checkAiUsageAllowed(env, job.authorId, kind);
  if (usage.allowed) {
    return true;
  }

  await sendChannelReply(env, job.channelId, usage.message).catch((error) => {
    logger.warn("ai_usage_denial_notice_failed", { error: errorMessage(error) });
  });
  return false;
};

// Resolution: everything that needs D1 or Discord REST. Returns the chat job to
// process in-process, or null when the message is irrelevant or denied (denial
// notices leave via sendChannelReply).
export const resolveGatewayMessage = async (
  job: GatewayMessageJob,
  env: Env,
): Promise<AiChatJob | null> => {
  // Defense in depth: handleMessageCreate already gates on the guild allowlist,
  // but the resolver is invoked independently in tests and stays zero-trust.
  if (!isGuildAllowed(env, job.guildId)) {
    return null;
  }

  const existingThread = job.guildId ? await findAiThread(env, job.channelId) : null;
  let prompt: string | null;
  if (existingThread) {
    prompt = stripMentionTokens(job.content);
  } else {
    const botRoleIds = job.mentionRoleIds.length > 0 && job.guildId
      ? await fetchBotRoleIds(env, job.guildId, job.botUserId) : [];
    prompt = resolveChannelPrompt({
      content: job.content,
      mentions: job.mentionUserIds.map((id) => ({ id })),
      mention_roles: job.mentionRoleIds,
    }, job.botUserId, env.DISCORD_APPLICATION_ID, botRoleIds);
  }
  const kind = existingThread ? "thread_reply" : "channel_reply";
  if (!prompt || !(await gatewayUsageAllowed(job, env, kind))) return null;

  return {
    kind,
    ...(existingThread ? { thread: existingThread } : {}),
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

// The gateway mention reply, run in-process (formerly the workflows consumer's
// channel_reply/thread_reply branches). Builds the thread conversation, calls the
// model, and posts the reply into the channel.
const processChatJob = (job: AiChatJob, env: Env, startedAt: number) =>
  deliverAiReply(env, job, async (config, startAi) => {
    const { messages, thread } = await buildNormalThreadConversation(env, config, job);
    startAi();
    if (job.kind === "thread_reply" && isAskThread(thread)) {
      return runAskModeCompletion(env, config, {
        prompt: job.prompt,
        requesterUsername: job.requesterUsername ?? "user",
        conversation: messages.filter((message) => message.role !== "system"),
      }, job);
    }
    const result = await runTrackedChatCompletion(env, config, messages, job);
    return { result, responseText: result.content };
  }, startedAt);

// Gateway MESSAGE_CREATE entry point, called in-process by the DiscordGateway DO
// (which owns dedupe before invoking this). Pre-filters that are pure and local —
// skip bots, non-allowed guilds (and DMs), and empty prompts — then resolve
// against D1/Discord and run the reply. Thread relevance depends on D1 the
// gateway cannot see, so any non-bot message with a usable prompt is resolved.
export const handleMessageCreate = async (
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

  const startedAt = Date.now();
  let resolved: AiChatJob | null = null;
  try {
    resolved = await resolveGatewayMessage(gatewayMessageJob(message, botUserId), env);
  } catch (error) {
    logger.error("gateway_message_resolve_failed", { error: errorMessage(error) });
  }
  if (!resolved) {
    return;
  }
  await processChatJob(resolved, env, startedAt);
};
