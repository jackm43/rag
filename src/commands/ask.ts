import { SlashCommandBuilder } from "../structs/slash-command-builder";

import type { ChatModelResult } from "../lib/ai/ai";
import {
  appendSourceFallback,
  buildAskConversation,
  buildAskWebSearchInput,
  shouldUseAskWebSearch,
} from "../lib/ai/ask-mode";
import { loadConfig } from "../lib/ai/config";
import { runTrackedChatCompletion, runTrackedWebSearchCompletion } from "../lib/ai/tracked-ai";
import { fallbackThreadTitle } from "../lib/db/conversation";
import { recordAiThread } from "../lib/db/threads";
import {
  createThreadWithoutMessage,
  fetchChannel,
  finalizeAiReplyText,
  isThreadChannel,
  sendChannelReply,
} from "../lib/discord";
import { errorMessage, logger } from "../lib/logger";
import { getInvoker, getInvokerDisplayName, stringOption } from "../lib/interaction";
import type { Env } from "../env";
import type { Command } from "../structs/command";

const resolveThreadParentChannelId = async (env: Env, channelId: string) => {
  const channel = await fetchChannel(env, channelId);
  if (channel && isThreadChannel(channel) && channel.parent_id) {
    return channel.parent_id;
  }
  return channelId;
};

// Records the AI interaction for analytics. Best-effort; a failed write is
// logged and never bubbles. Ported from the workflows consumer.
const recordAiInteraction = async (
  env: Env,
  fields: {
    channelId: string;
    requesterUserId?: string;
    requesterUsername?: string;
    prompt: string;
  },
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
        "ask",
        fields.channelId,
        null,
        fields.requesterUserId ?? null,
        fields.requesterUsername ?? null,
        fields.prompt,
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

// The /ask AI reply, run in-process behind the deferred ack (formerly the
// workflows consumer's `ask` job). Generates the answer and posts it into the
// freshly-created thread; a failure posts a soft notice there instead.
const generateAskReply = async (
  env: Env,
  threadId: string,
  prompt: string,
  requesterUserId: string | undefined,
  requesterUsername: string,
) => {
  const startedAt = Date.now();
  let model = "unknown";
  let aiDurationMs: number | null = null;
  let content: string | null = null;
  const fields = { channelId: threadId, requesterUserId, requesterUsername, prompt };

  try {
    const config = await loadConfig(env);
    model = config.responseModel;
    const attribution = {
      kind: "ask",
      requesterUserId,
      requesterUsername,
      channelId: threadId,
    };
    const messages = [{ role: "user" as const, content: `${requesterUsername}: ${prompt}` }];

    let responseText: string;
    let result: ChatModelResult;
    const aiStartedAt = Date.now();
    if (shouldUseAskWebSearch(prompt)) {
      const webSearchResult = await runTrackedWebSearchCompletion(
        env,
        buildAskWebSearchInput(prompt, requesterUsername, []),
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
      result = await runTrackedChatCompletion(env, config, buildAskConversation(config, messages), attribution);
      responseText = result.content;
    }
    model = result.model;
    aiDurationMs = Date.now() - aiStartedAt;
    content = finalizeAiReplyText(responseText);

    await sendChannelReply(env, threadId, responseText);
    await recordAiInteraction(
      env,
      fields,
      model,
      Date.now() - startedAt,
      "ok",
      content,
      aiDurationMs,
      null,
      result.usage?.promptTokens ?? null,
      result.usage?.completionTokens ?? null,
      result.usage?.totalTokens ?? null,
    );
  } catch (error) {
    logger.error("ai_job_failed", { error: errorMessage(error) });
    await recordAiInteraction(env, fields, model, Date.now() - startedAt, "error", content, aiDurationMs, errorMessage(error));
    await sendChannelReply(
      env,
      threadId,
      "I started this thread, but the AI response failed. Try again in a moment.",
    ).catch(() => undefined);
  }
};

export const ask: Command = {
  aiLimited: true,
  data: new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Start an AI conversation in a new thread")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Question or topic for the new thread")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(6000),
    ),
  async execute({ interaction, env, editReply }) {
    const prompt = stringOption(interaction, "prompt");
    const parentChannelId = interaction.channel_id;
    if (!parentChannelId) {
      await editReply("Run /ask in a server channel so I can create a thread.");
      return;
    }

    const requester = getInvoker(interaction);
    const requesterUsername = getInvokerDisplayName(interaction);
    const title = fallbackThreadTitle(prompt);
    const targetChannelId = await resolveThreadParentChannelId(env, parentChannelId);
    const thread = await createThreadWithoutMessage(env, targetChannelId, title).catch((error) => {
      logger.warn("ask_thread_create_failed", {
        error: errorMessage(error),
        channelId: targetChannelId,
      });
      return null;
    });
    if (!thread) {
      await editReply("I could not create a thread for that question.");
      return;
    }

    await recordAiThread(env, {
      threadId: thread.id,
      parentChannelId: targetChannelId,
      requesterUserId: requester?.id,
      requesterUsername,
      initialPrompt: prompt,
      title,
    });

    await editReply(`Started <#${thread.id}>`);

    await generateAskReply(env, thread.id, prompt, requester?.id, requesterUsername);
  },
};
