import { runChatModel, sanitizeAiText, streamChatModel, type ChatMessage } from "./ai";
import { selfIdentity } from "./self";
import { ensureRagbotSchema } from "./schema";
import { loadConfig, type BotConfig } from "./config";
import { fetchBotRoleIds, fetchChannelMessages, fetchMessage, postChannelMessage } from "./discord";
import { rejectDisallowedGuild } from "./guild";
import { errorMessage, logger, resolveSecret, type Identity } from "@platy/sdk";
import type { AiChannelJob, AiJob, ChannelPromptSource, DiscordMessage, Env } from "./types";

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

export const extractReplyToBotPrompt = (
  content: string,
  referencedAuthorId: string | undefined,
  botUserId: string,
) => {
  if (!referencedAuthorId || referencedAuthorId !== botUserId) {
    return null;
  }
  const prompt = stripMentionTokens(content);
  return prompt.length > 0 ? prompt : null;
};

export type ChannelPrompt = {
  prompt: string;
  source: ChannelPromptSource;
};

export const resolveChannelPrompt = (
  message: ChannelPromptMessage,
  botUserId: string,
  referencedAuthorId?: string,
  applicationId?: string,
  botRoleIds?: readonly string[],
): ChannelPrompt | null => {
  if (messageMentionsBot(message, botUserId, applicationId, botRoleIds)) {
    const prompt = stripMentionTokens(message.content ?? "");
    return prompt.length > 0 ? { prompt, source: "mention" } : null;
  }
  const prompt = extractReplyToBotPrompt(message.content ?? "", referencedAuthorId, botUserId);
  return prompt ? { prompt, source: "reply" } : null;
};

const claimChannelMessageJob = async (env: Env, messageId: string, channelId: string) => {
  const result = await env.DB.prepare(
    "INSERT INTO rag_message_jobs (message_id, channel_id) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING",
  )
    .bind(messageId, channelId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
};

const channelMessageAlreadyAnswered = async (env: Env, messageId: string) => {
  const row = await env.DB.prepare(
    "SELECT id FROM rag_ai_interactions WHERE message_id = ? AND status = 'ok' LIMIT 1",
  )
    .bind(messageId)
    .first<{ id: number }>();
  return row !== null;
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

export const handleGatewayMessageCreate = async (
  message: DiscordMessage,
  env: Env,
  botUserId: string | null,
) => {
  if (message.author?.bot || !botUserId) {
    return;
  }

  if (rejectDisallowedGuild(env, message.guild_id)) {
    return;
  }

  let referencedMessage = message.referenced_message ?? null;
  let replyMessageId = message.message_reference?.message_id;
  if (!referencedMessage && replyMessageId) {
    const channelId = message.message_reference?.channel_id ?? message.channel_id;
    referencedMessage = await fetchMessage(env, channelId, replyMessageId).catch(() => null);
  }

  let botRoleIds: string[] = [];
  if (message.mention_roles?.length && message.guild_id) {
    botRoleIds = await fetchBotRoleIds(env, message.guild_id, botUserId);
  }

  const prompt = resolveChannelPrompt(
    message,
    botUserId,
    referencedMessage?.author?.id,
    await resolveSecret(env.DISCORD_APPLICATION_ID),
    botRoleIds,
  );
  if (!prompt) {
    logger.info("channel_prompt_ignored", {
      channelId: message.channel_id,
      messageId: message.id,
      requesterUserId: message.author?.id,
      requesterUsername: message.author?.username,
      contentLength: message.content?.length ?? 0,
      contentPrefix: message.content?.slice(0, 80),
      mentionIds: message.mentions?.map((mention) => String(mention.id)),
      mentionRoleIds: message.mention_roles,
      botUserId,
    });
    return;
  }

  let replyContext: string | undefined;
  if (referencedMessage) {
    replyContext = formatReplyContext(referencedMessage) ?? undefined;
    replyMessageId = referencedMessage.id;
  }

  const claimed = await claimChannelMessageJob(env, message.id, message.channel_id);
  if (!claimed) {
    logger.info("ai_job_duplicate_skipped", {
      channelId: message.channel_id,
      messageId: message.id,
    });
    return;
  }

  await env.AI_JOBS.send({
    kind: "channel",
    channelId: message.channel_id,
    messageId: message.id,
    botUserId,
    requesterUserId: message.author?.id,
    requesterUsername: message.author?.username,
    prompt: prompt.prompt,
    promptSource: prompt.source,
    replyMessageId,
    replyContext,
  });
  logger.info("ai_job_enqueued", {
    channelId: message.channel_id,
    messageId: message.id,
    requesterUsername: message.author?.username,
  });
};

const cleanHistoryContent = (content: string) =>
  stripMentionTokens(content).slice(0, MAX_HISTORY_ENTRY_LENGTH);

const isRagAnnouncement = (content: string) => /\bhas just ragged\b/i.test(content);

const isCasualGreeting = (prompt: string) =>
  /^(?:hey|hi|hello|sup|yo|howdy|hiya|heya|what'?s up|gm|morning|evening|night)\s*[!.?]*$/i.test(
    prompt.trim(),
  );

const buildConversation = async (env: Env, config: BotConfig, job: AiChannelJob): Promise<ChatMessage[]> => {
  const messages: ChatMessage[] = [{ role: "system", content: config.systemPrompt }];

  let history: DiscordMessage[] = [];
  if (job.channelId) {
    const options = job.messageId
      ? { before: job.messageId, limit: config.historyLimit }
      : job.kind === "rpc"
        ? { limit: config.historyLimit }
        : null;
    if (options) {
      history = await fetchChannelMessages(env, job.channelId, options).catch((error) => {
        logger.warn("history_fetch_failed", { error: errorMessage(error) });
        return [];
      });
    }
  }

  const historyIds = new Set(history.map((message) => message.id));
  for (const message of [...history].reverse()) {
    const content = cleanHistoryContent(message.content ?? "");
    if (!content) {
      continue;
    }
    if (job.botUserId && message.author?.id === job.botUserId) {
      if (isRagAnnouncement(content)) {
        continue;
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    const username = message.author?.username ?? "user";
    messages.push({ role: "user", content: `[${username}] ${content}` });
  }

  const promptParts: string[] = [];
  if (job.replyContext && (!job.replyMessageId || !historyIds.has(job.replyMessageId))) {
    promptParts.push(job.replyContext);
  }
  const username = job.requesterUsername ?? "user";
  promptParts.push(`[${username}] ${job.prompt}`);
  let userContent = promptParts.join("\n\n");
  if (isCasualGreeting(job.prompt)) {
    userContent += "\n\n(They only greeted you — reply warmly and briefly, no insults or roasts.)";
  }
  messages.push({ role: "user", content: userContent });

  return messages;
};

const channelChatModel = (config: BotConfig, promptSource?: ChannelPromptSource) =>
  promptSource === "mention" ? config.mentionModel : config.responseModel;

export type ChannelChatInput = {
  kind?: "channel" | "rpc";
  channelId?: string;
  messageId?: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  promptSource?: ChannelPromptSource;
  replyMessageId?: string;
  replyContext?: string;
};

export type ChannelChatResult = {
  responseText: string;
  model: string;
  aiDurationMs: number;
  totalDurationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ChannelChatStreamChunk = {
  delta: string;
  done?: boolean;
  responseText?: string;
  model?: string;
  aiDurationMs?: number;
  totalDurationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export async function* streamChannelChat(
  env: Env,
  identity: Identity,
  input: ChannelChatInput,
): AsyncGenerator<ChannelChatStreamChunk> {
  const startedAt = Date.now();
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("prompt is required");
  }

  const config = await loadConfig(env);
  const job: AiChannelJob = {
    kind: input.kind ?? "rpc",
    channelId: input.channelId ?? "",
    messageId: input.messageId,
    botUserId: input.botUserId,
    requesterUserId: input.requesterUserId,
    requesterUsername: input.requesterUsername,
    prompt,
    promptSource: input.promptSource,
    replyMessageId: input.replyMessageId,
    replyContext: input.replyContext,
  };

  const conversation = await buildConversation(env, config, job);
  const chatModel = channelChatModel(config, input.promptSource);
  const aiStartedAt = Date.now();
  let rawText = "";
  let resolvedModel = chatModel;
  let usage:
    | {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }
    | undefined;
  for await (const chunk of streamChatModel(env, identity, config, conversation, { model: chatModel })) {
    if (chunk.done) {
      rawText = chunk.content;
      resolvedModel = chunk.model;
      usage = chunk.usage;
      break;
    }
    rawText += chunk.delta;
    if (chunk.delta) {
      yield { delta: chunk.delta };
    }
  }

  const aiDurationMs = Date.now() - aiStartedAt;
  const text = sanitizeAiText(rawText);
  const responseText =
    text.length > 0 ? text.slice(0, MAX_DISCORD_MESSAGE_LENGTH) : "I could not generate a response.";

  yield {
    delta: "",
    done: true,
    responseText,
    model: resolvedModel,
    aiDurationMs,
    totalDurationMs: Date.now() - startedAt,
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
    totalTokens: usage?.totalTokens,
  };
}

export const runChannelChat = async (
  env: Env,
  identity: Identity,
  input: ChannelChatInput,
): Promise<ChannelChatResult> => {
  const startedAt = Date.now();
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("prompt is required");
  }

  const config = await loadConfig(env);
  const job: AiChannelJob = {
    kind: input.kind ?? "rpc",
    channelId: input.channelId ?? "",
    messageId: input.messageId,
    botUserId: input.botUserId,
    requesterUserId: input.requesterUserId,
    requesterUsername: input.requesterUsername,
    prompt,
    promptSource: input.promptSource,
    replyMessageId: input.replyMessageId,
    replyContext: input.replyContext,
  };

  const conversation = await buildConversation(env, config, job);
  const chatModel = channelChatModel(config, input.promptSource);
  const aiStartedAt = Date.now();
  const result = await runChatModel(env, identity, config, conversation, { model: chatModel });
  const aiDurationMs = Date.now() - aiStartedAt;
  const text = sanitizeAiText(result.content);
  const responseText =
    text.length > 0 ? text.slice(0, MAX_DISCORD_MESSAGE_LENGTH) : "I could not generate a response.";

  return {
    responseText,
    model: result.model,
    aiDurationMs,
    totalDurationMs: Date.now() - startedAt,
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    totalTokens: result.usage?.totalTokens,
  };
};

export const recordChannelChatInteraction = async (
  env: Env,
  input: ChannelChatInput,
  result: Pick<
    ChannelChatResult,
    "model" | "responseText" | "aiDurationMs" | "totalDurationMs" | "promptTokens" | "completionTokens" | "totalTokens"
  >,
  status: string,
  errorText: string | null,
) => {
  const job: AiChannelJob = {
    kind: input.kind ?? "rpc",
    channelId: input.channelId ?? "",
    messageId: input.messageId,
    botUserId: input.botUserId,
    requesterUserId: input.requesterUserId,
    requesterUsername: input.requesterUsername,
    prompt: input.prompt,
    replyMessageId: input.replyMessageId,
    replyContext: input.replyContext,
  };
  await recordAiInteraction(
    env,
    job,
    result.model,
    result.totalDurationMs,
    status,
    result.responseText,
    result.aiDurationMs,
    errorText,
    result.promptTokens ?? null,
    result.completionTokens ?? null,
    result.totalTokens ?? null,
  );
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
  promptTokens: number | null,
  completionTokens: number | null,
  totalTokens: number | null,
) => {
  try {
    await ensureRagbotSchema(env);
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

export const processAiQueueMessage = async (message: Message<AiJob>, env: Env) => {
  const startedAt = Date.now();
  const job = message.body;
  if (job.kind === "channel" && job.messageId && (await channelMessageAlreadyAnswered(env, job.messageId))) {
    logger.info("ai_job_already_answered", {
      channelId: job.channelId,
      messageId: job.messageId,
    });
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
    const identity = await selfIdentity(env);
    const result = await runChannelChat(env, identity, job);
    model = result.model;
    aiDurationMs = result.aiDurationMs;
    content = result.responseText;
    promptTokens = result.promptTokens ?? null;
    completionTokens = result.completionTokens ?? null;
    totalTokens = result.totalTokens ?? null;

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
