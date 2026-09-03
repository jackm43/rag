// /ask conversation shaping and web-search routing. Ported verbatim from
// packages/discord/ai/ask-mode.ts.
import type { ChatMessage, ChatModelResult, WebSearchSource } from "./ai";
import type { BotConfig } from "./config";
import { runTrackedChatCompletion, runTrackedWebSearchCompletion, type SpendAttribution } from "./tracked-ai";
import type { Env } from "../../env";

const explicitWebSearchPattern =
  /\b(search|web search|look up|lookup|google|online|on the web|sources?|cite|citation)\b/i;
const currentInfoPattern =
  /\b(current|currently|latest|today|now|right now|recent|newest|this week|this month|202[4-9]|news|price|pricing|availability|available|released?|launch(?:ed)?|schedule|law|legal|regulation|market|stock|weather)\b/i;
const comparisonResearchPattern =
  /\b(best|top|compare|comparison|versus|vs\.?|recommend|recommendation|buy|worth it)\b/i;
const productOrOrgPattern =
  /\b(gpu|cpu|graphics card|nvidia|amd|intel|apple|laptop|phone|product|model|prices?|availability|performance|benchmark|review)\b/i;

export const shouldUseAskWebSearch = (prompt: string) =>
  explicitWebSearchPattern.test(prompt) ||
  currentInfoPattern.test(prompt) ||
  (comparisonResearchPattern.test(prompt) && productOrOrgPattern.test(prompt));

const currentDate = () => new Date().toISOString().slice(0, 10);

export const buildAskConversation = (
  config: BotConfig,
  messages: ChatMessage[],
): ChatMessage[] => [
  {
    role: "system",
    content: `${config.systemPrompt}\n\nThis is a /ask thread. Answer using only this thread's conversation context and the current user message; do not use unrelated channel history. Keep the direct, helpful /ask style instead of normal channel banter. Do not include Discord mentions or raw IDs.`,
  },
  ...messages,
];

export const buildAskWebSearchInput = (
  prompt: string,
  requesterUsername: string,
  conversationContext: ChatMessage[] = [],
) => {
  const lines = [
    `Current date: ${currentDate()}`,
    `Requester display name: ${requesterUsername}`,
    "Discord slash command: /ask",
    "",
  ];

  if (conversationContext.length > 0) {
    lines.push(
      "Thread conversation context:",
      ...conversationContext.map((message) => `${message.role}: ${message.content}`),
      "",
    );
  }

  lines.push("Current user prompt:", prompt);
  return lines.join("\n");
};

const sourceUrlPattern = /https?:\/\//i;

export const appendSourceFallback = (content: string, sources: WebSearchSource[]) => {
  if (sourceUrlPattern.test(content) || sources.length === 0) {
    return content;
  }
  // <angle brackets> keep the links clickable but suppress Discord embeds,
  // matching the responder's egress policy for URLs in model output.
  const urls = sources.slice(0, 3).map((source) => `<${source.url}>`).join(" ");
  return `${content}\n\nSources: ${urls}`;
};

export type AskModeInput = {
  prompt: string;
  requesterUsername: string;
  // Non-system turns, ending with the current user turn.
  conversation: ChatMessage[];
  // Context lines for the web-search prompt; defaults to `conversation`.
  webSearchContext?: ChatMessage[];
};

export type AskModeReply = { result: ChatModelResult; responseText: string };

// The /ask answer path shared by the slash command and tracked-thread replies:
// route the prompt to the web-search model when it looks like it needs fresh
// information, otherwise to the chat model with the /ask system prompt.
export const runAskModeCompletion = async (
  env: Env,
  config: BotConfig,
  input: AskModeInput,
  attribution: SpendAttribution,
): Promise<AskModeReply> => {
  if (shouldUseAskWebSearch(input.prompt)) {
    const result = await runTrackedWebSearchCompletion(
      env,
      buildAskWebSearchInput(input.prompt, input.requesterUsername, input.webSearchContext ?? input.conversation),
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
    return { result, responseText: appendSourceFallback(result.content, result.sources) };
  }

  const result = await runTrackedChatCompletion(
    env,
    config,
    buildAskConversation(config, input.conversation),
    attribution,
  );
  return { result, responseText: result.content };
};
