import { runChatModel, sanitizeAiText, type ChatMessage } from "./ai";
import { loadConfig, type BotConfig } from "./config";
import { fetchChannelMessages, fetchMessage, postChannelMessage } from "./discord";
import { errorMessage, logger } from "./logger";
import type { AiChannelJob, AiJob, DiscordMessage, Env } from "./types";

const MAX_DISCORD_MESSAGE_LENGTH = 1900;
const MAX_HISTORY_ENTRY_LENGTH = 600;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const extractBotMentionPrompt = (content: string, botUserId: string) => {
  const mentionUserId = botUserId.trim();
  if (!mentionUserId) {
    return null;
  }

  const trimmed = content.trim();
  const mentionPattern = new RegExp(`^<@!?${escapeRegExp(mentionUserId)}>(?:\\s+|$)`);
  const match = trimmed.match(mentionPattern);
  if (!match) {
    return null;
  }

  const prompt = trimmed.slice(match[0].length).trim();
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

export const handleGatewayMessageCreate = async (
  message: DiscordMessage,
  env: Env,
  botUserId: string | null,
) => {
  if (message.author?.bot || !botUserId) {
    return;
  }

  const prompt = extractBotMentionPrompt(message.content ?? "", botUserId);
  if (!prompt) {
    return;
  }

  let replyContext: string | undefined;
  let replyMessageId = message.message_reference?.message_id;
  if (message.referenced_message) {
    replyContext = formatReplyContext(message.referenced_message) ?? undefined;
    replyMessageId = message.referenced_message.id;
  } else if (replyMessageId) {
    const channelId = message.message_reference?.channel_id ?? message.channel_id;
    const referenced = await fetchMessage(env, channelId, replyMessageId).catch(() => null);
    replyContext = referenced ? formatReplyContext(referenced) ?? undefined : undefined;
  }

  await env.AI_JOBS.send({
    kind: "channel",
    channelId: message.channel_id,
    messageId: message.id,
    botUserId,
    requesterUserId: message.author?.id,
    requesterUsername: message.author?.username,
    prompt,
    replyMessageId,
    replyContext,
  });
};

const cleanHistoryContent = (content: string) =>
  content
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HISTORY_ENTRY_LENGTH);

const buildConversation = async (env: Env, config: BotConfig, job: AiChannelJob): Promise<ChatMessage[]> => {
  const messages: ChatMessage[] = [{ role: "system", content: config.systemPrompt }];

  let history: DiscordMessage[] = [];
  if (job.messageId) {
    history = await fetchChannelMessages(env, job.channelId, {
      before: job.messageId,
      limit: config.historyLimit,
    }).catch((error) => {
      logger.warn("history_fetch_failed", { error: errorMessage(error) });
      return [];
    });
  }

  const historyIds = new Set(history.map((message) => message.id));
  for (const message of [...history].reverse()) {
    const content = cleanHistoryContent(message.content ?? "");
    if (!content) {
      continue;
    }
    if (job.botUserId && message.author?.id === job.botUserId) {
      messages.push({ role: "assistant", content });
      continue;
    }
    const username = message.author?.username ?? "user";
    messages.push({ role: "user", content: `${username}: ${content}` });
  }

  const promptParts: string[] = [];
  if (job.replyContext && (!job.replyMessageId || !historyIds.has(job.replyMessageId))) {
    promptParts.push(job.replyContext);
  }
  const username = job.requesterUsername ?? "user";
  promptParts.push(`${username}: ${job.prompt}`);
  messages.push({ role: "user", content: promptParts.join("\n\n") });

  return messages;
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
) => {
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
  } catch (error) {
    logger.warn("interaction_record_failed", { error: errorMessage(error) });
  }
};

export const processAiQueueMessage = async (message: Message<AiJob>, env: Env) => {
  const startedAt = Date.now();
  const job = message.body;
  let model = "unknown";
  let aiDurationMs: number | null = null;
  let content: string | null = null;
  const record = (status: string, errorText: string | null) =>
    recordAiInteraction(env, job, model, Date.now() - startedAt, status, content, aiDurationMs, errorText);

  try {
    const config = await loadConfig(env);
    model = config.responseModel;
    const conversation = await buildConversation(env, config, job);

    const aiStartedAt = Date.now();
    const rawText = await runChatModel(env, config, conversation);
    aiDurationMs = Date.now() - aiStartedAt;

    const text = sanitizeAiText(rawText);
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
