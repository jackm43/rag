import {
  runChatCompletion,
  runWebSearchCompletion,
  sanitizeAiText,
  type ChatMessage,
} from "./ai";
import { buildAiGatewayMetadata } from "./ai-metadata";
import {
  appendSourceFallback,
  buildAskConversation,
  buildAskWebSearchInput,
  shouldUseAskWebSearch,
} from "./ask-mode";
import { processRagjamJob } from "./commands/ragjam";
import { loadConfig, type BotConfig } from "./config";
import {
  createThreadFromMessage,
  fetchBotRoleIds,
  fetchChannelMessages,
  fetchMessage,
  postChannelMessage,
} from "./discord";
import { errorMessage, logger } from "./logger";
import { createAiSpendSourceId, recordAiSpendEvent } from "./spend";
import type { AiChatJob, AiJob, AiThread, DiscordMessage, Env } from "./types";
import { isAiJob } from "./validation";

const MAX_DISCORD_MESSAGE_LENGTH = 1900;
const MAX_HISTORY_ENTRY_LENGTH = 600;
const MAX_THREAD_TITLE_LENGTH = 80;

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

const getConversationAuthorDisplayName = (message: DiscordMessage, job: AiChatJob) =>
  message.author?.id && message.author.id === job.requesterUserId && job.requesterUsername
    ? job.requesterUsername
    : getMessageAuthorDisplayName(message);

type AiThreadRow = {
  thread_id: string;
  parent_channel_id: string | null;
  source_message_id: string | null;
  requester_user_id: string | null;
  requester_username: string | null;
  initial_prompt: string;
  title: string;
};

const toAiThread = (row: AiThreadRow): AiThread => ({
  threadId: row.thread_id,
  parentChannelId: row.parent_channel_id ?? undefined,
  sourceMessageId: row.source_message_id ?? undefined,
  requesterUserId: row.requester_user_id ?? undefined,
  requesterUsername: row.requester_username ?? undefined,
  initialPrompt: row.initial_prompt,
  title: row.title,
});

const getAiThread = async (env: Env, threadId: string): Promise<AiThread | null> => {
  const row = await env.DB.prepare(
    "SELECT thread_id, parent_channel_id, source_message_id, requester_user_id, requester_username, initial_prompt, title FROM rag_ai_threads WHERE thread_id = ?",
  )
    .bind(threadId)
    .first<AiThreadRow>();
  return row ? toAiThread(row) : null;
};

const findAiThread = async (env: Env, threadId: string): Promise<AiThread | null> =>
  getAiThread(env, threadId).catch((error) => {
    logger.warn("ai_thread_lookup_failed", { error: errorMessage(error) });
    return null;
  });

export const recordAiThread = async (env: Env, thread: AiThread) => {
  await env.DB.prepare(
    "INSERT INTO rag_ai_threads (thread_id, parent_channel_id, source_message_id, requester_user_id, requester_username, initial_prompt, title, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(thread_id) DO UPDATE SET parent_channel_id = excluded.parent_channel_id, source_message_id = excluded.source_message_id, requester_user_id = excluded.requester_user_id, requester_username = excluded.requester_username, initial_prompt = excluded.initial_prompt, title = excluded.title, updated_at = CURRENT_TIMESTAMP",
  )
    .bind(
      thread.threadId,
      thread.parentChannelId ?? null,
      thread.sourceMessageId ?? null,
      thread.requesterUserId ?? null,
      thread.requesterUsername ?? null,
      thread.initialPrompt,
      thread.title,
    )
    .run();
};

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

const fallbackThreadTitle = (prompt: string) =>
  sanitizeThreadTitle(prompt) ?? "Chat with Ragbot";

export const generateThreadTitle = async (
  env: Env,
  config: BotConfig,
  prompt: string,
  spendAttribution?: {
    kind: string;
    requesterUserId?: string | null;
    requesterUsername?: string | null;
  },
) => {
  const fallback = fallbackThreadTitle(prompt);
  try {
    const spendSourceId = spendAttribution ? createAiSpendSourceId() : undefined;
    const result = await runChatCompletion(
      env,
      config,
      [
        {
          role: "system",
          content:
            "Create a concise Discord thread title for this user question. Plain text only, no quotes, no mentions, no IDs, 8 words or fewer.",
        },
        { role: "user", content: prompt },
      ],
      {
        maxTokens: 32,
        temperature: 0.2,
        metadata: spendAttribution
          ? buildAiGatewayMetadata({
            kind: spendAttribution.kind,
            requestId: spendSourceId,
            requesterUserId: spendAttribution.requesterUserId,
          })
          : undefined,
      },
    );
    if (spendAttribution) {
      await recordAiSpendEvent(env, {
        kind: spendAttribution.kind,
        requesterUserId: spendAttribution.requesterUserId,
        requesterUsername: spendAttribution.requesterUsername,
        model: result.model,
        promptTokens: result.usage?.promptTokens ?? null,
        completionTokens: result.usage?.completionTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
        sourceId: spendSourceId,
      });
    }
    return sanitizeThreadTitle(result.content) ?? fallback;
  } catch (error) {
    logger.warn("thread_title_generation_failed", { error: errorMessage(error) });
    return fallback;
  }
};

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

const cleanHistoryContent = (content: string) =>
  stripMentionTokens(content).slice(0, MAX_HISTORY_ENTRY_LENGTH);

const isRagCommandOutput = (content: string) =>
  /\bhas just ragged\.(?:\s+Total: \d+)?(?=\s|$)/.test(content) ||
  content.trimStart().startsWith("Ragboard\n");

type BuiltThreadConversation = {
  messages: ChatMessage[];
  thread: AiThread | null;
};

const isAskThread = (thread: AiThread | null) => Boolean(thread && !thread.sourceMessageId);

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

const buildNormalThreadConversation = async (
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

const buildConversation = async (env: Env, config: BotConfig, job: AiChatJob): Promise<ChatMessage[]> =>
  (await buildNormalThreadConversation(env, config, job)).messages;

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

  if (job.kind === "ragjam") {
    await processRagjamJob(job, env);
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
    const builtConversation = job.kind === "thread_reply"
      ? await buildNormalThreadConversation(env, config, job)
      : { messages: await buildConversation(env, config, job), thread: null };

    let responseText: string;

    const aiStartedAt = Date.now();
    if (job.kind === "thread_reply" && isAskThread(builtConversation.thread)) {
      if (shouldUseAskWebSearch(job.prompt)) {
        const spendSourceId = createAiSpendSourceId();
        const result = await runWebSearchCompletion(
          env,
          buildAskWebSearchInput(
            job.prompt,
            job.requesterUsername ?? "user",
            builtConversation.messages.filter((message) => message.role !== "system"),
          ),
          {
            model: config.askWebSearchModel,
            instructions: config.askWebSearchSystemPrompt,
            maxOutputTokens: config.askWebSearchMaxOutputTokens,
            maxTurns: config.askWebSearchMaxTurns,
            searchContextSize: config.askWebSearchContextSize,
            temperature: config.askWebSearchTemperature,
            gatewayId: config.askWebSearchGatewayId,
            metadata: buildAiGatewayMetadata({
              kind: job.kind,
              requestId: spendSourceId,
              requesterUserId: job.requesterUserId,
              channelId: job.channelId,
              messageId: job.messageId,
            }),
          },
        );
        responseText = appendSourceFallback(result.content, result.sources);
        model = result.model;
        promptTokens = result.usage?.promptTokens ?? null;
        completionTokens = result.usage?.completionTokens ?? null;
        totalTokens = result.usage?.totalTokens ?? null;
        await recordAiSpendEvent(env, {
          kind: job.kind,
          requesterUserId: job.requesterUserId,
          requesterUsername: job.requesterUsername,
          model,
          promptTokens,
          completionTokens,
          totalTokens,
          sourceId: spendSourceId,
        });
      } else {
        const spendSourceId = createAiSpendSourceId();
        const result = await runChatCompletion(
          env,
          config,
          buildAskConversation(config, builtConversation.messages.filter((message) => message.role !== "system")),
          {
            metadata: buildAiGatewayMetadata({
              kind: job.kind,
              requestId: spendSourceId,
              requesterUserId: job.requesterUserId,
              channelId: job.channelId,
              messageId: job.messageId,
            }),
          },
        );
        responseText = result.content;
        model = result.model;
        promptTokens = result.usage?.promptTokens ?? null;
        completionTokens = result.usage?.completionTokens ?? null;
        totalTokens = result.usage?.totalTokens ?? null;
        await recordAiSpendEvent(env, {
          kind: job.kind,
          requesterUserId: job.requesterUserId,
          requesterUsername: job.requesterUsername,
          model,
          promptTokens,
          completionTokens,
          totalTokens,
          sourceId: spendSourceId,
        });
      }
    } else {
      const spendSourceId = createAiSpendSourceId();
      const result = await runChatCompletion(env, config, builtConversation.messages, {
        metadata: buildAiGatewayMetadata({
          kind: job.kind,
          requestId: spendSourceId,
          requesterUserId: job.requesterUserId,
          channelId: job.channelId,
          messageId: job.messageId,
        }),
      });
      responseText = result.content;
      model = result.model;
      promptTokens = result.usage?.promptTokens ?? null;
      completionTokens = result.usage?.completionTokens ?? null;
      totalTokens = result.usage?.totalTokens ?? null;
      await recordAiSpendEvent(env, {
        kind: job.kind,
        requesterUserId: job.requesterUserId,
        requesterUsername: job.requesterUsername,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        sourceId: spendSourceId,
      });
    }
    aiDurationMs = Date.now() - aiStartedAt;

    const text = sanitizeAiText(responseText);
    content =
      text.length > 0 ? text.slice(0, MAX_DISCORD_MESSAGE_LENGTH) : "I could not generate a response.";

    let responseChannelId = job.channelId;
    if (job.kind === "thread_start") {
      const title = await generateThreadTitle(env, config, job.prompt, {
        kind: `${job.kind}_title`,
        requesterUserId: job.requesterUserId,
        requesterUsername: job.requesterUsername,
      });
      const thread = await createThreadFromMessage(env, job.channelId, job.messageId, title);
      if (!thread) {
        await record("discord_thread_create_invalid", null);
        message.ack();
        return;
      }

      responseChannelId = thread.id;
      await recordAiThread(env, {
        threadId: thread.id,
        parentChannelId: job.channelId,
        sourceMessageId: job.messageId,
        requesterUserId: job.requesterUserId,
        requesterUsername: job.requesterUsername,
        initialPrompt: job.prompt,
        title,
      });
    }

    const response = await postChannelMessage(env, responseChannelId, content);
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
