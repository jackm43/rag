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
const isGatewayWorkersAiModel = (model: string) => model.startsWith("workers-ai/");
const isBindingModel = (model: string) => isWorkersAiModel(model) || isGatewayWorkersAiModel(model);

const toBindingModel = (model: string) =>
  isGatewayWorkersAiModel(model) ? model.slice("workers-ai/".length) : model;

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

const gatewayChatCompletions = async (
  env: Env,
  gatewayId: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
) => {
  if (!env.CF_ACCOUNT_ID || !env.CF_AIG_TOKEN) {
    throw new Error("CF_ACCOUNT_ID and CF_AIG_TOKEN are required for partner AI Gateway models");
  }

  const response = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/compat/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as ChatResult;
  if (!response.ok) {
    const detail =
      Array.isArray(payload.error) ? payload.error.map((item) => item.message).filter(Boolean).join("; ")
        : typeof payload.error === "string" ? payload.error
          : payload.error?.message ?? payload.message ?? payload.description ?? response.statusText;
    throw new Error(`AI Gateway request failed (${response.status}): ${detail}`);
  }

  return payload;
};

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
  const bindingModel = toBindingModel(model);

  const input = { messages, max_tokens: maxTokens, temperature };

  const result =
    requestConfig.gatewayId && !isBindingModel(model)
      ? await gatewayChatCompletions(env, requestConfig.gatewayId, model, messages, maxTokens, temperature)
      : await env.AI.run(
        bindingModel as never,
        input as never,
        requestConfig.gatewayId ? ({ gateway: { id: requestConfig.gatewayId } } as never) : undefined,
      );
  const payload = result as ChatResult;
  return {
    content: extractText(payload),
    model: payload.model ?? bindingModel,
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
