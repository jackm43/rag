import type { BotConfig } from "./config";
import type { Env } from "./types";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatResult = {
  response?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
};

const isWorkersAiModel = (model: string) => model.startsWith("@cf/");

const extractText = (result: unknown): string => {
  if (typeof result === "string") {
    return result;
  }
  const chat = result as ChatResult;
  if (typeof chat?.response === "string") {
    return chat.response;
  }
  return chat?.choices?.[0]?.message?.content ?? "";
};

// Strips Discord mention syntax and raw snowflake IDs so the model output can
// never ping anyone, while preserving line breaks for readability.
export const sanitizeAiText = (value: string) =>
  value
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/\b\d{17,20}\b/g, "")
    .replace(/@(everyone|here)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export type ChatOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export const runChatModel = async (
  env: Env,
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> => {
  const model = options.model ?? config.responseModel;
  const maxTokens = options.maxTokens ?? config.maxTokens;
  const temperature = options.temperature ?? config.temperature;

  // Workers AI models use max_tokens; partner models (xai/, openai/, ...)
  // expose the OpenAI-compatible max_completion_tokens parameter.
  const input = isWorkersAiModel(model)
    ? { messages, max_tokens: maxTokens, temperature }
    : { messages, max_completion_tokens: maxTokens, temperature };

  const runOptions = config.gatewayId ? { gateway: { id: config.gatewayId } } : undefined;
  const result = await env.AI.run(model as never, input as never, runOptions as never);
  return extractText(result);
};

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
};
