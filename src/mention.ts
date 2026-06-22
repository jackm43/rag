import { runChatCompletion, sanitizeAiText, type ChatMessage } from "./ai";
import { loadConfig, type BotConfig } from "./config";
import { fetchBotRoleIds, fetchChannelMessages, fetchMessage, postChannelMessage } from "./discord";
import { errorMessage, logger } from "./logger";
import { loadWorkspaceContext, recordDiscordMessage, recordDiscordMessages } from "./memory";
import type { AiChannelJob, AiJob, DiscordMessage, Env } from "./types";
import { isAiJob } from "./validation";

const MAX_DISCORD_MESSAGE_LENGTH = 1900;
const MAX_HISTORY_ENTRY_LENGTH = 600;

export type ChannelPromptMessage = Pick<DiscordMessage, "content" | "mentions" | "mention_roles">;

const mentionTokens = (content: string) => [...content.matchAll(/<@([!&]?)([^>\s]+)>/g)];

const stripMentionTokens = (content: string) =>
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

const formatReplyContext = (message: DiscordMessage) => {
  const parts: string[] = [];
  const content = message.content?.trim();
  if (content) {
    parts.push(content);
  }

  for (const attachment of message.attachments ?? []) {
    const contentType = attachment.content_type ? ` (${attachment.content_type})` : "";
    const url = attachment.url ? ` ${attachment.url}` : "";
    parts.push(`Attachment: ${attachment.filename}${contentType}${url}`);
  }

  if (parts.length === 0) {
    return null;
  }

  const author = message.author?.username?.trim();
  const label = author ? `Replied-to message from ${author}:` : "Replied-to message:";
  return `${label}\n${parts.join("\n")}`;
};

const getMessageAuthorDisplayName = (message: DiscordMessage) =>
  message.member?.nick?.trim() ||
  message.author?.global_name?.trim() ||
  message.author?.username?.trim() ||
  "user";

const getConversationAuthorDisplayName = (message: DiscordMessage, job: AiChannelJob) =>
  message.author?.id && message.author.id === job.requesterUserId && job.requesterUsername
    ? job.requesterUsername
    : getMessageAuthorDisplayName(message);

export const handleGatewayMessageCreate = async (
  message: DiscordMessage,
  env: Env,
  botUserId: string | null,
) => {
  if (message.author?.bot || !botUserId) {
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

  const replyMessageId = message.message_reference?.message_id ?? message.referenced_message?.id;
  const replyChannelId =
    message.message_reference?.channel_id ?? message.referenced_message?.channel_id;

  await env.AI_JOBS.send({
    kind: "channel",
    ...(message.guild_id ? { guildId: message.guild_id } : {}),
    channelId: message.channel_id,
    messageId: message.id,
    botUserId,
    requesterUserId: message.author?.id,
    requesterUsername: getMessageAuthorDisplayName(message),
    prompt,
    replyMessageId,
    replyChannelId,
  });
};

const cleanHistoryContent = (content: string) =>
  stripMentionTokens(content).slice(0, MAX_HISTORY_ENTRY_LENGTH);

const isRagCommandOutput = (content: string) =>
  /\bhas just ragged\. Total: \d+\b/.test(content) || content.trimStart().startsWith("Ragboard\n");

const buildConversation = async (env: Env, config: BotConfig, job: AiChannelJob): Promise<ChatMessage[]> => {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${config.systemPrompt}\n\nThis is a normal chat reply, not the /rag command. Do not include rag counts, leaderboard totals, or phrases like "has just ragged" unless the user explicitly asks about the rag leaderboard. If the same user appears under different account names, global names, or nicknames in context, treat them as one person and do not mention multiple aliases in the same reply.`,
    },
  ];

  let history: DiscordMessage[] = [];
  if (job.messageId) {
    history = await fetchChannelMessages(env, job.channelId, {
      before: job.messageId,
      limit: config.historyLimit,
    }).catch((error) => {
      logger.warn("history_fetch_failed", { error: errorMessage(error) });
      return [];
    });
    await recordDiscordMessages(env, history).catch((error) => {
      logger.debug("history_record_failed", { error: errorMessage(error) });
    });
  }

  const historyIds = new Set(history.map((message) => message.id));
  for (const message of [...history].reverse()) {
    const content = cleanHistoryContent(message.content ?? "");
    if (!content) {
      continue;
    }
    if (job.botUserId && message.author?.id === job.botUserId) {
      if (isRagCommandOutput(content)) {
        continue;
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    const username = getConversationAuthorDisplayName(message, job);
    messages.push({ role: "user", content: `${username}: ${content}` });
  }

  const promptParts: string[] = [];
  if (job.replyMessageId && !historyIds.has(job.replyMessageId)) {
    const replyChannelId = job.replyChannelId ?? job.channelId;
    const referenced = await fetchMessage(env, replyChannelId, job.replyMessageId).catch((error) => {
      logger.warn("reply_context_fetch_failed", { error: errorMessage(error) });
      return null;
    });
    if (referenced) {
      await recordDiscordMessage(env, referenced).catch((error) => {
        logger.debug("reply_context_record_failed", { error: errorMessage(error) });
      });
    }
    const replyContext = referenced ? formatReplyContext(referenced) : null;
    if (replyContext) {
      promptParts.push(replyContext);
    }
  }
  const username = job.requesterUsername ?? "user";
  promptParts.push(`${username}: ${job.prompt}`);
  messages.push({ role: "user", content: promptParts.join("\n\n") });

  return messages;
};

const addAssistantContext = async (
  env: Env,
  job: AiChannelJob,
  conversation: ChatMessage[],
) => {
  const workspaceContext = await loadWorkspaceContext(env, job, job.prompt);
  if (!workspaceContext) {
    return conversation;
  }

  const workspaceMessage: ChatMessage = {
    role: "system",
    content: `Workspace memory and usage context:\n${workspaceContext}`,
  };

  return [
    conversation[0],
    workspaceMessage,
    ...conversation.slice(1),
  ];
};

const recordAiInteraction = async (
  env: Env,
  job: AiChannelJob,
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
    try {
      await env.DB.prepare(
        "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        )
        .run();
    } catch (fallbackError) {
      logger.warn("interaction_record_failed", {
        error: errorMessage(fallbackError),
        firstError: errorMessage(error),
      });
    }
  }
};

export const processAiQueueMessage = async (message: Message<AiJob>, env: Env) => {
  const startedAt = Date.now();
  const job = message.body;
  if (!isAiJob(job)) {
    logger.warn("ai_job_invalid");
    message.ack();
    return;
  }

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
    const conversation = await addAssistantContext(
      env,
      job,
      await buildConversation(env, config, job),
    );

    const aiStartedAt = Date.now();
    const result = await runChatCompletion(env, config, conversation);
    aiDurationMs = Date.now() - aiStartedAt;
    model = result.model;
    promptTokens = result.usage?.promptTokens ?? null;
    completionTokens = result.usage?.completionTokens ?? null;
    totalTokens = result.usage?.totalTokens ?? null;

    const text = sanitizeAiText(result.content);
    content =
      text.length > 0 ? text.slice(0, MAX_DISCORD_MESSAGE_LENGTH) : "I could not generate a response.";

    const response = await postChannelMessage(env, job.channelId, content);
    if (response.ok) {
      await record("ok", null);
    } else {
      await record(`discord_${response.status}`, await response.text().catch(() => null));
    }
  } catch (error) {
    logger.error("ai_job_failed", { error: errorMessage(error) });
    await record("error", errorMessage(error));
  }
  message.ack();
};
