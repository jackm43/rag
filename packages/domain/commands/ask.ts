import { encodeAiJobEnvelope } from "../../contracts";
import { fallbackThreadTitle } from "../conversation";
import { createThreadWithoutMessage, fetchChannel, isThreadChannel } from "../../discord";
import { jsonResponse } from "../http";
import { checkAiUsageAllowed } from "../limits";
import { errorMessage, logger } from "../../logger";
import { recordAiThread } from "../threads";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../../contracts/types";
import { handleDeferredInteraction } from "./deferred";
import { getInvokerDisplayName } from "./rag-utils";

export { shouldUseAskWebSearch } from "../../ai/ask-mode";

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

  await env.AI_JOBS.send(
    encodeAiJobEnvelope(
      {
        kind: "ask",
        channelId: thread.id,
        requesterUserId: requester?.id,
        requesterUsername,
        prompt,
      },
      { source: "interactions", guildId: interaction.guild_id },
    ),
  );

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

  return handleDeferredInteraction(interaction, env, ctx, {
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
