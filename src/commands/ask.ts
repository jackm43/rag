import {
  runChatCompletion,
  runWebSearchCompletion,
  sanitizeAiText,
  type ChatMessage,
  type WebSearchSource,
} from "../ai";
import { loadConfig, type BotConfig } from "../config";
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
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../types";

const MAX_DISCORD_MESSAGE_LENGTH = 1900;

const askPrompt = (interaction: DiscordInteraction) => {
  const value = interaction.data?.options?.find((option) => option.name === "prompt")?.value;
  return typeof value === "string" ? value.trim() : "";
};

const askWebSearchOverride = (interaction: DiscordInteraction) => {
  const value = interaction.data?.options?.find((option) => option.name === "web")?.value;
  return typeof value === "boolean" ? value : null;
};

const getInvoker = (interaction: DiscordInteraction) => interaction.member?.user ?? interaction.user;

const getInvokerDisplayName = (interaction: DiscordInteraction) =>
  interaction.member?.nick?.trim() ||
  interaction.member?.user?.global_name?.trim() ||
  interaction.user?.global_name?.trim() ||
  interaction.member?.user?.username?.trim() ||
  interaction.user?.username?.trim() ||
  "user";

const buildAskConversation = (config: BotConfig, prompt: string, requesterUsername: string): ChatMessage[] => [
  {
    role: "system",
    content: `${config.systemPrompt}\n\nThis is a fresh /ask thread. Answer the current user prompt without using unrelated channel history. Do not include Discord mentions or raw IDs.`,
  },
  {
    role: "user",
    content: `${requesterUsername}: ${prompt}`,
  },
];

const currentDate = () => new Date().toISOString().slice(0, 10);

const buildAskWebSearchInput = (prompt: string, requesterUsername: string) =>
  [
    `Current date: ${currentDate()}`,
    `Requester display name: ${requesterUsername}`,
    "Discord slash command: /ask",
    "",
    "User prompt:",
    prompt,
  ].join("\n");

const explicitWebSearchPattern =
  /\b(search|web search|look up|lookup|google|online|on the web|sources?|cite|citation)\b/i;
const currentInfoPattern =
  /\b(current|currently|latest|today|now|right now|recent|newest|this week|this month|202[4-9]|news|price|pricing|availability|available|released?|launch(?:ed)?|schedule|law|legal|regulation|market|stock|weather)\b/i;
const comparisonResearchPattern =
  /\b(best|top|compare|comparison|versus|vs\.?|recommend|recommendation|buy|worth it)\b/i;
const productOrOrgPattern =
  /\b(gpu|cpu|graphics card|nvidia|amd|intel|apple|laptop|phone|product|model|prices?|availability|performance|benchmark|review)\b/i;

export const shouldUseAskWebSearch = (prompt: string, override: boolean | null = null) => {
  if (override !== null) {
    return override;
  }
  return (
    explicitWebSearchPattern.test(prompt) ||
    currentInfoPattern.test(prompt) ||
    (comparisonResearchPattern.test(prompt) && productOrOrgPattern.test(prompt))
  );
};

const sourceUrlPattern = /https?:\/\//i;

const appendSourceFallback = (content: string, sources: WebSearchSource[]) => {
  if (sourceUrlPattern.test(content) || sources.length === 0) {
    return content;
  }
  const urls = sources.slice(0, 3).map((source) => source.url).join(" ");
  return `${content}\n\nSources: ${urls}`;
};

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
  const title = await generateThreadTitle(env, config, prompt);
  const targetChannelId = await resolveThreadParentChannelId(env, parentChannelId);
  const thread = await createThreadWithoutMessage(env, targetChannelId, title);
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

  const webSearch = shouldUseAskWebSearch(prompt, askWebSearchOverride(interaction));
  let responseText: string;
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
    const result = await runChatCompletion(env, config, buildAskConversation(config, prompt, requesterUsername));
    responseText = result.content;
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
