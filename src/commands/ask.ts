import {
  runChatCompletion,
  runWebSearchCompletion,
  sanitizeAiText,
} from "../ai";
import { buildAiGatewayMetadata } from "../ai-metadata";
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
import { createAiSpendSourceId, recordAiSpendEvent } from "../spend";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../types";

const MAX_DISCORD_MESSAGE_LENGTH = 1900;

export { shouldUseAskWebSearch } from "../ask-mode";

const askPrompt = (interaction: DiscordInteraction) => {
  const value = interaction.data?.options?.find((option) => option.name === "prompt")?.value;
  return typeof value === "string" ? value.trim() : "";
};

const getInvoker = (interaction: DiscordInteraction) => interaction.member?.user ?? interaction.user;

const getInvokerDisplayName = (interaction: DiscordInteraction) =>
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

const runAskCommand = async (interaction: DiscordInteraction, env: Env) => {
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
  let responseText: string;
  let spendModel = config.responseModel;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  let spendSourceId: string | null = null;
  try {
    if (webSearch) {
      spendSourceId = createAiSpendSourceId();
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
          metadata: buildAiGatewayMetadata({
            kind: "ask",
            requestId: spendSourceId,
            requesterUserId: requester?.id,
            channelId: parentChannelId,
          }),
        },
      );
      responseText = appendSourceFallback(result.content, result.sources);
      spendModel = result.model;
      promptTokens = result.usage?.promptTokens ?? null;
      completionTokens = result.usage?.completionTokens ?? null;
      totalTokens = result.usage?.totalTokens ?? null;
    } else {
      spendSourceId = createAiSpendSourceId();
      const result = await runChatCompletion(
        env,
        config,
        buildAskConversation(config, [{ role: "user", content: `${requesterUsername}: ${prompt}` }]),
        {
          metadata: buildAiGatewayMetadata({
            kind: "ask",
            requestId: spendSourceId,
            requesterUserId: requester?.id,
            channelId: parentChannelId,
          }),
        },
      );
      responseText = result.content;
      spendModel = result.model;
      promptTokens = result.usage?.promptTokens ?? null;
      completionTokens = result.usage?.completionTokens ?? null;
      totalTokens = result.usage?.totalTokens ?? null;
    }
    await recordAiSpendEvent(env, {
      kind: "ask",
      requesterUserId: requester?.id,
      requesterUsername,
      model: spendModel,
      promptTokens,
      completionTokens,
      totalTokens,
      sourceId: spendSourceId,
    });
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
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
) => {
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  const prompt = askPrompt(interaction);

  if (!prompt) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "A question is required.", allowed_mentions: { parse: [] } },
    });
  }

  if (!applicationId || !interactionToken) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
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

  return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
