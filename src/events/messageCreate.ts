import type { ChatMessage, ChatModelResult } from "../lib/ai/ai";
import {
  appendSourceFallback,
  buildAskConversation,
  buildAskWebSearchInput,
  shouldUseAskWebSearch,
} from "../lib/ai/ask-mode";
import { loadConfig } from "../lib/ai/config";
import { runTrackedChatCompletion, runTrackedWebSearchCompletion } from "../lib/ai/tracked-ai";
import { activeAiBanForUser } from "../lib/db/bans";
import { buildNormalThreadConversation, isAskThread } from "../lib/db/conversation";
import { isGuildAllowed } from "../lib/db/guilds";
import { checkAiUsageAllowed } from "../lib/db/limits";
import { findAiThread } from "../lib/db/threads";
import { fetchBotRoleIds, finalizeAiReplyText, sendChannelReply } from "../lib/discord";
import { isSnowflake, type AiChatJob, type DiscordMessage } from "../lib/contracts";
import { errorMessage, logger } from "../lib/logger";
import type { Env } from "../env";

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

const getMessageAuthorDisplayName = (message: DiscordMessage) =>
  message.member?.nick?.trim() ||
  message.author?.global_name?.trim() ||
  message.author?.username?.trim() ||
  "user";

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
    botRoleIds = await fetchBotRoleIds(env, job.guildId, job.botUserId);
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

// Best-effort analytics write. A failed insert is logged and never bubbles.
const recordAiInteraction = async (
  env: Env,
  job: AiChatJob,
  model: string,
  totalDurationMs: number,
  status: string,
  responseText: string | null,
  aiDurationMs: number | null,
  errorText: string | null,
  promptTokens: number | null = null,
  completionTokens: number | null = null,
  totalTokens: number | null = null,
) => {
  try {
    await env.DB.prepare(
      "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        job.kind,
        job.channelId,
        job.messageId ?? null,
        job.requesterUserId ?? null,
        job.requesterUsername ?? null,
        job.prompt,
        responseText,
        model,
        aiDurationMs,
        totalDurationMs,
        status,
        errorText,
        promptTokens,
        completionTokens,
        totalTokens,
      )
      .run();
  } catch (error) {
    logger.warn("interaction_record_failed", { error: errorMessage(error) });
  }
};

// The gateway mention reply, run in-process (formerly the workflows consumer's
// channel_reply/thread_reply branches). Builds the thread conversation, calls the
// model, and posts the reply into the channel.
const processChatJob = async (job: AiChatJob, env: Env, startedAt: number) => {
  let model = "unknown";
  let aiDurationMs: number | null = null;
  let content: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  const record = (status: string, errorText: string | null) =>
    recordAiInteraction(
      env,
      job,
      model,
      Date.now() - startedAt,
      status,
      content,
      aiDurationMs,
      errorText,
      promptTokens,
      completionTokens,
      totalTokens,
    );

  try {
    const config = await loadConfig(env);
    model = config.responseModel;
    const attribution = {
      kind: job.kind,
      requesterUserId: job.requesterUserId,
      requesterUsername: job.requesterUsername,
      channelId: job.channelId,
      messageId: job.messageId,
    };

    const builtConversation = await buildNormalThreadConversation(env, config, job);
    const messages: ChatMessage[] = builtConversation.messages;
    const askMode = job.kind === "thread_reply" && isAskThread(builtConversation.thread);

    let responseText: string;
    let result: ChatModelResult;

    const aiStartedAt = Date.now();
    if (askMode) {
      if (shouldUseAskWebSearch(job.prompt)) {
        const webSearchResult = await runTrackedWebSearchCompletion(
          env,
          buildAskWebSearchInput(
            job.prompt,
            job.requesterUsername ?? "user",
            messages.filter((message) => message.role !== "system"),
          ),
          {
            model: config.askWebSearchModel,
            instructions: config.askWebSearchSystemPrompt,
            maxOutputTokens: config.askWebSearchMaxOutputTokens,
            maxTurns: config.askWebSearchMaxTurns,
            searchContextSize: config.askWebSearchContextSize,
            temperature: config.askWebSearchTemperature,
            gatewayId: config.askWebSearchGatewayId,
            ...attribution,
          },
        );
        responseText = appendSourceFallback(webSearchResult.content, webSearchResult.sources);
        result = webSearchResult;
      } else {
        result = await runTrackedChatCompletion(
          env,
          config,
          buildAskConversation(config, messages.filter((message) => message.role !== "system")),
          attribution,
        );
        responseText = result.content;
      }
    } else {
      result = await runTrackedChatCompletion(env, config, messages, attribution);
      responseText = result.content;
    }
    model = result.model;
    promptTokens = result.usage?.promptTokens ?? null;
    completionTokens = result.usage?.completionTokens ?? null;
    totalTokens = result.usage?.totalTokens ?? null;
    aiDurationMs = Date.now() - aiStartedAt;

    // Record the exact text the egress policy will deliver.
    content = finalizeAiReplyText(responseText);

    await sendChannelReply(env, job.channelId, responseText);
    await record("ok", null);
  } catch (error) {
    logger.error("ai_job_failed", { error: errorMessage(error) });
    await record("error", errorMessage(error));
  }
};

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
