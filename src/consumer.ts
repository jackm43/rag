import { sanitizeAiText, type ChatMessage, type ChatModelResult } from "./ai";
import {
  appendSourceFallback,
  buildAskConversation,
  buildAskWebSearchInput,
  shouldUseAskWebSearch,
} from "./ask-mode";
import { processRagjamJob } from "./commands/ragjam";
import { loadConfig } from "./config";
import { buildNormalThreadConversation, fallbackThreadTitle, isAskThread } from "./conversation";
import { createThreadFromMessage, postChannelMessage } from "./discord";
import { errorMessage, logger } from "./logger";
import { recordAiThread } from "./threads";
import { runTrackedChatCompletion, runTrackedWebSearchCompletion } from "./tracked-ai";
import { decodeAiJobEnvelope } from "./contracts";
import { MAX_DISCORD_MESSAGE_LENGTH, type AiAskJob, type AiChatJob, type Env } from "./types";

const recordAiInteraction = async (
  env: Env,
  job: AiChatJob | AiAskJob,
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

export const processAiQueueMessage = async (message: Message<unknown>, env: Env) => {
  const startedAt = Date.now();
  const job = decodeAiJobEnvelope(message.body);
  if (!job) {
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
    const config = await loadConfig();
    model = config.responseModel;
    const attribution = {
      kind: job.kind,
      requesterUserId: job.requesterUserId,
      requesterUsername: job.requesterUsername,
      channelId: job.channelId,
      messageId: job.messageId,
    };

    let messages: ChatMessage[];
    let askMode: boolean;
    if (job.kind === "ask") {
      messages = [{ role: "user", content: `${job.requesterUsername ?? "user"}: ${job.prompt}` }];
      askMode = true;
    } else {
      const builtConversation = await buildNormalThreadConversation(env, config, job);
      messages = builtConversation.messages;
      askMode = job.kind === "thread_reply" && isAskThread(builtConversation.thread);
    }

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
            job.kind === "ask" ? [] : messages.filter((message) => message.role !== "system"),
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

    const text = sanitizeAiText(responseText);
    content =
      text.length > 0 ? text.slice(0, MAX_DISCORD_MESSAGE_LENGTH) : "I could not generate a response.";

    let responseChannelId = job.channelId;
    if (job.kind === "thread_start") {
      const title = fallbackThreadTitle(job.prompt);
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
    if (job.kind === "ask") {
      await postChannelMessage(
        env,
        job.channelId,
        "I started this thread, but the AI response failed. Try again in a moment.",
      ).catch(() => undefined);
    }
  }
  message.ack();
};
