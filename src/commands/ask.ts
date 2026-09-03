import { SlashCommandBuilder } from "../structs/slash-command-builder";

import { runAskModeCompletion } from "../lib/ai/ask-mode";
import { loadConfig } from "../lib/ai/config";
import { fallbackThreadTitle } from "../lib/db/conversation";
import { recordAiInteraction } from "../lib/db/interactions";
import { recordAiThread } from "../lib/db/threads";
import {
  createThreadWithoutMessage,
  fetchChannel,
  finalizeAiReplyText,
  isThreadChannel,
  postChannelMessage,
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
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
  const record = (status: "ok" | "error", errorText: string | null) =>
    recordAiInteraction(env, {
      kind: "ask",
      channelId: threadId,
      requesterUserId,
      requesterUsername,
      prompt,
      model,
      status,
      responseText: content,
      errorMessage: errorText,
      aiDurationMs,
      totalDurationMs: Date.now() - startedAt,
      usage,
    });

  try {
    const config = await loadConfig(env);
    model = config.responseModel;
    const attribution = { kind: "ask", requesterUserId, requesterUsername, channelId: threadId };

    const aiStartedAt = Date.now();
    const { result, responseText } = await runAskModeCompletion(
      env,
      config,
      {
        prompt,
        requesterUsername,
        conversation: [{ role: "user", content: `${requesterUsername}: ${prompt}` }],
        // A fresh thread has no prior turns to feed the web-search prompt.
        webSearchContext: [],
      },
      attribution,
    );
    model = result.model;
    usage = result.usage ?? null;
    aiDurationMs = Date.now() - aiStartedAt;
    content = finalizeAiReplyText(responseText);

    const posted = await postChannelMessage(env, threadId, content);
    if (!posted.ok) {
      throw new Error(`discord_channel_post_failed_${posted.status}`);
    }
    await record("ok", null);
  } catch (error) {
    logger.error("ai_job_failed", { error: errorMessage(error) });
    await record("error", errorMessage(error));
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

    // The thread already exists on Discord; a failed D1 write only means later
    // replies in it will not be tracked, so still deliver the first answer.
    await recordAiThread(env, {
      threadId: thread.id,
      parentChannelId: targetChannelId,
      requesterUserId: requester?.id,
      requesterUsername,
      initialPrompt: prompt,
      title,
    }).catch((error) => {
      logger.warn("ask_thread_record_failed", { error: errorMessage(error), threadId: thread.id });
    });

    await editReply(`Started <#${thread.id}>`);

    await generateAskReply(env, thread.id, prompt, requester?.id, requesterUsername);
  },
};
