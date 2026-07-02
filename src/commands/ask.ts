import { sanitizeAiText } from "../ai";
import {
  appendSourceFallback,
  buildAskConversation,
  buildAskWebSearchInput,
  shouldUseAskWebSearch,
} from "../ask-mode";
import { loadConfig } from "../config";
import { generateThreadTitle } from "../conversation";
import {
  createThreadWithoutMessage,
  fetchChannel,
  isThreadChannel,
  postChannelMessage,
} from "../discord";
import { jsonResponse } from "../http";
import { checkAiUsageAllowed } from "../limits";
import { errorMessage, logger } from "../logger";
import { recordAiThread } from "../threads";
import { runTrackedChatCompletion, runTrackedWebSearchCompletion } from "../tracked-ai";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  MAX_DISCORD_MESSAGE_LENGTH,
  type DiscordInteraction,
  type Env,
} from "../types";
import { handleDeferredInteraction } from "./deferred";
import { getInvokerDisplayName } from "./rag-utils";

export { shouldUseAskWebSearch } from "../ask-mode";

const askPrompt = (interaction: DiscordInteraction) => {
  const value = interaction.data?.options?.find((option) => option.name === "prompt")?.value;
  return typeof value === "string" ? value.trim() : "";
};

const getInvoker = (interaction: DiscordInteraction) => interaction.member?.user ?? interaction.user;

const resolveThreadParentChannelId = async (env: Env, channelId: string) => {
  const channel = await fetchChannel(env, channelId);
  if (channel && isThreadChannel(channel) && channel.parent_id) {
    return channel.parent_id;
  }
  return channelId;
};

const runAskCommand = async (interaction: DiscordInteraction, env: Env) => {
  const prompt = askPrompt(interaction);
  const parentChannelId = interaction.channel_id;
  if (!prompt) {
    return { content: "A question is required.", allowed_mentions: { parse: [] } };
  }
  if (!parentChannelId) {
    return { content: "Run /ask in a server channel so I can create a thread.", allowed_mentions: { parse: [] } };
  }

  const config = await loadConfig();
  const requester = getInvoker(interaction);
  const requesterUsername = getInvokerDisplayName(interaction);
  const title = await generateThreadTitle(env, config, prompt, {
    kind: "ask_title",
    requesterUserId: requester?.id,
    requesterUsername,
  });
  const targetChannelId = await resolveThreadParentChannelId(env, parentChannelId);
  const thread = await createThreadWithoutMessage(env, targetChannelId, title).catch((error) => {
    logger.warn("ask_thread_create_failed", {
      error: errorMessage(error),
      channelId: targetChannelId,
    });
    return null;
  });
  if (!thread) {
    return { content: "I could not create a thread for that question.", allowed_mentions: { parse: [] } };
  }

  await recordAiThread(env, {
    threadId: thread.id,
    parentChannelId: targetChannelId,
    requesterUserId: requester?.id,
    requesterUsername,
    initialPrompt: prompt,
    title,
  });

  const webSearch = shouldUseAskWebSearch(prompt);
  const attribution = {
    kind: "ask",
    requesterUserId: requester?.id,
    requesterUsername,
    channelId: parentChannelId,
  };
  let responseText: string;
  try {
    if (webSearch) {
      const result = await runTrackedWebSearchCompletion(
        env,
        buildAskWebSearchInput(prompt, requesterUsername),
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
      responseText = appendSourceFallback(result.content, result.sources);
    } else {
      const result = await runTrackedChatCompletion(
        env,
        config,
        buildAskConversation(config, [{ role: "user", content: `${requesterUsername}: ${prompt}` }]),
        attribution,
      );
      responseText = result.content;
    }
  } catch (error) {
    logger.error("ask_ai_response_failed", {
      error: errorMessage(error),
      threadId: thread.id,
      webSearch,
    });
    await postChannelMessage(
      env,
      thread.id,
      "I started this thread, but the AI response failed. Try again in a moment.",
    ).catch(() => undefined);
    return {
      content: `Started <#${thread.id}>, but the AI response failed.`,
      allowed_mentions: { parse: [] },
    };
  }

  const text = sanitizeAiText(responseText);
  const content =
    text.length > 0 ? text.slice(0, MAX_DISCORD_MESSAGE_LENGTH) : "I could not generate a response.";
  const response = await postChannelMessage(env, thread.id, content);
  if (!response.ok) {
    logger.warn("ask_thread_post_failed", {
      status: response.status,
      error: await response.text().catch(() => null),
    });
    return {
      content: `I created <#${thread.id}> but could not post the answer there.`,
      allowed_mentions: { parse: [] },
    };
  }

  return {
    content: `Started <#${thread.id}>`,
    allowed_mentions: { parse: [] },
  };
};

export const handleAskCommand = async (
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
) => {
  const prompt = askPrompt(interaction);

  if (!prompt) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "A question is required.", allowed_mentions: { parse: [] } },
    });
  }

  const usage = await checkAiUsageAllowed(env, getInvoker(interaction)?.id, "ask");
  if (!usage.allowed) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: usage.message, allowed_mentions: { parse: [] } },
    });
  }

  return handleDeferredInteraction(interaction, ctx, {
    run: () => runAskCommand(interaction, env),
    failureMessage: "Could not start that AI thread. Try again.",
    logEvent: "ask_command_failed",
    onMissingCredentials: () =>
      jsonResponse({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Could not defer /ask without interaction credentials.", allowed_mentions: { parse: [] } },
      }),
  });
};
