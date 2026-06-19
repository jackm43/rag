import type { BotConfig } from "./config";
import type { Env } from "./types";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatResult = {
  response?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string } | Array<{ message?: string }> | string;
  message?: string;
  description?: string;
};

const isWorkersAiModel = (model: string) => model.startsWith("@cf/");

const toGatewayModel = (model: string) => (isWorkersAiModel(model) ? `workers-ai/${model}` : model);

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

const usageFrom = (usage: ChatResult["usage"]) =>
  usage
    ? {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    }
    : undefined;

const looksLikeSpeakerLine = (line: string) => {
  const colon = line.indexOf(":");
  if (colon <= 0 || colon > 32) {
    return false;
  }
  return line.slice(colon + 1).trimStart().length > 0;
};

const stripLeadingSpeakerLines = (value: string) => {
  const lines = value.split("\n");
  let start = 0;
  while (start < lines.length) {
    const trimmed = lines[start].trim();
    if (!trimmed) {
      start += 1;
      continue;
    }
    if (looksLikeSpeakerLine(trimmed)) {
      lines[start] = trimmed.slice(trimmed.indexOf(":") + 1).trimStart();
    }
    break;
  }
  return lines.slice(start).join("\n");
};

// Strips Discord mention syntax and raw snowflake IDs so the model output can
// never ping anyone, while preserving line breaks for readability.
export const sanitizeAiText = (value: string) =>
  stripLeadingSpeakerLines(value)
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/\b\d{17,20}\b/g, "")
    .replace(/@(everyone|here)/g, "$1")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export type ChatOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  gatewayId?: string | null;
};

export type ChatModelResult = {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

const canUseAiGateway = (env: Env, config: BotConfig) =>
  Boolean(config.gatewayId && env.CF_ACCOUNT_ID && env.CF_AIG_TOKEN);

const runAiGatewayChat = async (
  env: Env,
  config: BotConfig,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<ChatModelResult> => {
  const requestedModel = toGatewayModel(model);
  const url = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${config.gatewayId}/compat/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
    },
    body: JSON.stringify({
      model: requestedModel,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = result as ChatResult;
    const detail = typeof error.error === "string"
      ? error.error
      : Array.isArray(error.error)
        ? error.error.map((entry) => entry.message).filter(Boolean).join("; ")
        : error.error?.message ?? error.message ?? error.description;
    throw new Error(detail || `AI Gateway returned ${response.status}`);
  }

  const payload = result as ChatResult;
  return {
    content: extractText(payload),
    model: payload.model ?? requestedModel,
    usage: usageFrom(payload.usage),
  };
};

export const runChatCompletion = async (
  env: Env,
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatModelResult> => {
  const model = options.model ?? config.responseModel;
  const maxTokens = options.maxTokens ?? config.maxTokens;
  const temperature = options.temperature ?? config.temperature;
  const requestConfig = { ...config, gatewayId: options.gatewayId ?? config.gatewayId };

  if (canUseAiGateway(env, requestConfig)) {
    return runAiGatewayChat(env, requestConfig, model, messages, maxTokens, temperature);
  }

  // Workers AI models use max_tokens; partner models (xai/, openai/, ...)
  // expose the OpenAI-compatible max_completion_tokens parameter.
  const input = isWorkersAiModel(model)
    ? { messages, max_tokens: maxTokens, temperature }
    : { messages, max_completion_tokens: maxTokens, temperature };

  const runOptions = requestConfig.gatewayId ? { gateway: { id: requestConfig.gatewayId } } : undefined;
  const result = await env.AI.run(model as never, input as never, runOptions as never);
  const payload = result as ChatResult;
  return {
    content: extractText(payload),
    model: payload.model ?? model,
    usage: usageFrom(payload.usage),
  };
};

export const runChatModel = async (
  env: Env,
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> => (await runChatCompletion(env, config, messages, options)).content;

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
};
