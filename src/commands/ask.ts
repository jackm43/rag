import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/payloads/v10";

import {
  runChatCompletion,
  runWebSearchCompletion,
  sanitizeAiText,
} from "../ai";
import {
  appendSourceFallback,
  buildAskConversation,
  buildAskWebSearchInput,
  shouldUseAskWebSearch,
} from "../ask-mode";
import { loadConfig } from "../config";
import {
  createThreadWithoutMessage,
  editOriginalInteractionResponse,
  fetchChannel,
  isThreadChannel,
  postChannelMessage,
} from "../discord";
import { jsonResponse } from "../http";
import { errorMessage, logger } from "../logger";
import { generateThreadTitle, recordAiThread } from "../mention";
import type { Env } from "../types";

const MAX_DISCORD_MESSAGE_LENGTH = 1900;
const DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DISCORD_RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

export { shouldUseAskWebSearch } from "../ask-mode";

const stringOptionValue = (
  interaction: APIChatInputApplicationCommandInteraction,
  name: string,
) => {
  const option = interaction.data?.options?.find((item) => item.name === name);
  return option && "value" in option && typeof option.value === "string" ? option.value : "";
};

const askPrompt = (interaction: APIChatInputApplicationCommandInteraction) => {
  return stringOptionValue(interaction, "prompt").trim();
};

const getInvoker = (interaction: APIChatInputApplicationCommandInteraction) =>
  interaction.member?.user ?? interaction.user;

const getInvokerDisplayName = (interaction: APIChatInputApplicationCommandInteraction) =>
  interaction.member?.nick?.trim() ||
  interaction.member?.user?.global_name?.trim() ||
  interaction.user?.global_name?.trim() ||
  interaction.member?.user?.username?.trim() ||
  interaction.user?.username?.trim() ||
  "user";

const resolveThreadParentChannelId = async (env: Env, channelId: string) => {
  const channel = await fetchChannel(env, channelId);
  if (channel && isThreadChannel(channel) && channel.parent_id) {
    return channel.parent_id;
  }
  return channelId;
};

const runAskCommand = async (interaction: APIChatInputApplicationCommandInteraction, env: Env) => {
  const prompt = askPrompt(interaction);
  const parentChannelId = interaction.channel_id;
  if (!prompt) {
    return { content: "A question is required.", allowed_mentions: { parse: [] } };
  }
  if (!parentChannelId) {
    return { content: "Run /ask in a server channel so I can create a thread.", allowed_mentions: { parse: [] } };
  }

  const config = await loadConfig(env);
  const requester = getInvoker(interaction);
  const requesterUsername = getInvokerDisplayName(interaction);
  const title = await generateThreadTitle(env, config, prompt);
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
  let responseText: string;
  try {
    if (webSearch) {
      const result = await runWebSearchCompletion(
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
        },
      );
      responseText = appendSourceFallback(result.content, result.sources);
    } else {
      const result = await runChatCompletion(
        env,
        config,
        buildAskConversation(config, [{ role: "user", content: `${requesterUsername}: ${prompt}` }]),
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

export const handleAskCommand = (
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env,
  ctx: ExecutionContext,
) => {
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  const prompt = askPrompt(interaction);

  if (!prompt) {
    return jsonResponse({
      type: DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "A question is required.", allowed_mentions: { parse: [] } },
    });
  }

  if (!applicationId || !interactionToken) {
    return jsonResponse({
      type: DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Could not defer /ask without interaction credentials.", allowed_mentions: { parse: [] } },
    });
  }

  ctx.waitUntil(
    (async () => {
      try {
        await editOriginalInteractionResponse(
          applicationId,
          interactionToken,
          await runAskCommand(interaction, env),
        );
      } catch (error) {
        logger.error("ask_command_failed", { error: errorMessage(error) });
        await editOriginalInteractionResponse(applicationId, interactionToken, {
          content: "Could not start that AI thread. Try again.",
          allowed_mentions: { parse: [] },
        }).catch(() => undefined);
      }
    })(),
  );

  return jsonResponse({ type: DISCORD_RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
