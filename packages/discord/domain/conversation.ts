import { sanitizeAiText, type ChatMessage } from "../ai/ai";
import type { BotConfig } from "../ai/config";
import { fetchChannelMessages, fetchMessage } from "../api";
import { errorMessage, logger } from "@rag/logger";
import { getMessageAuthorDisplayName, stripMentionTokens } from "./mention";
import { findAiThread } from "./threads";
import type { AiChatJob, AiThread, DiscordMessage, Env } from "../contracts";

const MAX_HISTORY_ENTRY_LENGTH = 600;
const MAX_THREAD_TITLE_LENGTH = 80;

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

const getConversationAuthorDisplayName = (message: DiscordMessage, job: AiChatJob) =>
  message.author?.id && message.author.id === job.requesterUserId && job.requesterUsername
    ? job.requesterUsername
    : getMessageAuthorDisplayName(message);

const trimToTitleLength = (value: string) => {
  if (value.length <= MAX_THREAD_TITLE_LENGTH) {
    return value;
  }
  const sliced = value.slice(0, MAX_THREAD_TITLE_LENGTH).trim();
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace >= 24 ? sliced.slice(0, lastSpace) : sliced).trim();
};

export const sanitizeThreadTitle = (value: string) => {
  const title = sanitizeAiText(value)
    .split("\n")[0]
    .replace(/^["'`]+/, "")
    .replace(/["'`.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title ? trimToTitleLength(title) : null;
};

export const fallbackThreadTitle = (prompt: string) =>
  sanitizeThreadTitle(prompt) ?? "Chat with Ragbot";

const cleanHistoryContent = (content: string) =>
  stripMentionTokens(content).slice(0, MAX_HISTORY_ENTRY_LENGTH);

const isRagCommandOutput = (content: string) =>
  /\bhas just ragged\.(?:\s+Total: \d+)?(?=\s|$)/.test(content) ||
  content.trimStart().startsWith("Ragboard\n");

type BuiltThreadConversation = {
  messages: ChatMessage[];
  thread: AiThread | null;
};

export const isAskThread = (thread: AiThread | null) => Boolean(thread && !thread.sourceMessageId);

const buildThreadConversationMessages = async (
  env: Env,
  config: BotConfig,
  job: AiChatJob,
): Promise<BuiltThreadConversation> => {
  let thread: AiThread | null = null;
  const messages: ChatMessage[] = [];
  let history: DiscordMessage[] = [];

  if (job.kind === "thread_reply") {
    thread = await findAiThread(env, job.channelId);
    if (thread?.initialPrompt) {
      const username = thread.requesterUsername ?? "user";
      messages.push({ role: "user", content: `${username}: ${thread.initialPrompt}` });
    }
  }

  if (job.kind === "thread_reply" && job.messageId) {
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
    const replyContext = referenced ? formatReplyContext(referenced) : null;
    if (replyContext) {
      promptParts.push(replyContext);
    }
  }

  const username = job.requesterUsername ?? "user";
  promptParts.push(`${username}: ${job.prompt}`);
  messages.push({ role: "user", content: promptParts.join("\n\n") });

  return { messages, thread };
};

export const buildNormalThreadConversation = async (
  env: Env,
  config: BotConfig,
  job: AiChatJob,
): Promise<BuiltThreadConversation> => {
  const { messages, thread } = await buildThreadConversationMessages(env, config, job);
  return {
    thread,
    messages: [
      {
        role: "system",
        content: `${config.systemPrompt}\n\nThis is a normal chat reply, not the /rag command. Use only the provided thread conversation context and the current user message; do not infer context from unrelated channel history. Do not include rag counts, leaderboard totals, or phrases like "has just ragged" unless the user explicitly asks about the rag leaderboard. If the same user appears under different account names, global names, or nicknames in context, treat them as one person and do not mention multiple aliases in the same reply.`,
      },
      ...messages,
    ],
  };
};
