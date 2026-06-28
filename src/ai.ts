import type { BotConfig } from "./config";
import type { Env } from "./types";
import { isRecord } from "./validation";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type WebSearchContextSize = "low" | "medium" | "high";

export type AiGatewayMetadata = Record<string, string | number | boolean>;

const isWorkersAiModel = (model: string) => model.startsWith("@cf/");
const isGatewayWorkersAiModel = (model: string) => model.startsWith("workers-ai/");
const isBindingModel = (model: string) => isWorkersAiModel(model) || isGatewayWorkersAiModel(model);

const toBindingModel = (model: string) =>
  isGatewayWorkersAiModel(model) ? model.slice("workers-ai/".length) : model;

const extractText = (result: unknown): string => {
  if (typeof result === "string") {
    return result;
  }
  if (!isRecord(result)) {
    return "";
  }
  if (typeof result.response === "string") {
    return result.response;
  }
  const firstChoice = Array.isArray(result.choices) ? result.choices[0] : undefined;
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    return "";
  }
  return typeof firstChoice.message.content === "string" ? firstChoice.message.content : "";
};

const optionalUsageNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const usageFrom = (usage: unknown) =>
  isRecord(usage)
    ? {
      promptTokens: optionalUsageNumber(usage.prompt_tokens ?? usage.input_tokens),
      completionTokens: optionalUsageNumber(usage.completion_tokens ?? usage.output_tokens),
      totalTokens: optionalUsageNumber(usage.total_tokens),
    }
    : undefined;

const errorDetailFrom = (payload: unknown, fallback: string) => {
  if (!isRecord(payload)) {
    return fallback;
  }

  const error = payload.error;
  if (Array.isArray(error)) {
    return error
      .map((item) => isRecord(item) && typeof item.message === "string" ? item.message : null)
      .filter((message): message is string => Boolean(message))
      .join("; ") || fallback;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload.description === "string") {
    return payload.description;
  }
  return fallback;
};

const modelFrom = (payload: unknown, fallback: string) =>
  isRecord(payload) && typeof payload.model === "string" ? payload.model : fallback;

const gatewayChatCompletions = async (
  env: Env,
  gatewayId: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  metadata?: AiGatewayMetadata,
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
        ...(metadata ? { "cf-aig-metadata": JSON.stringify(metadata) } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = errorDetailFrom(payload, response.statusText);
    throw new Error(`AI Gateway request failed (${response.status}): ${detail}`);
  }

  return payload;
};

const gatewayWebSearchChatCompletions = async (
  env: Env,
  gatewayId: string,
  model: string,
  input: string,
  instructions: string,
  maxTokens: number,
  searchContextSize: WebSearchContextSize,
  metadata?: AiGatewayMetadata,
) => {
  if (!env.CF_ACCOUNT_ID || !env.CF_AIG_TOKEN) {
    throw new Error("CF_ACCOUNT_ID and CF_AIG_TOKEN are required for AI Gateway web-search models");
  }

  const response = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/compat/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
        ...(metadata ? { "cf-aig-metadata": JSON.stringify(metadata) } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: input },
        ],
        max_tokens: maxTokens,
        web_search_options: { search_context_size: searchContextSize },
      }),
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = errorDetailFrom(payload, response.statusText);
    throw new Error(`AI Gateway web-search request failed (${response.status}): ${detail}`);
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
  metadata?: AiGatewayMetadata;
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

export type WebSearchSource = {
  url: string;
  title?: string;
};

export type WebSearchChatOptions = {
  model: string;
  instructions: string;
  maxOutputTokens: number;
  temperature: number;
  maxTurns: number;
  searchContextSize: WebSearchContextSize;
  gatewayId?: string | null;
  metadata?: AiGatewayMetadata;
};

export type WebSearchModelResult = ChatModelResult & {
  sources: WebSearchSource[];
  webSearchCalls: number;
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
      ? await gatewayChatCompletions(env, requestConfig.gatewayId, model, messages, maxTokens, temperature, options.metadata)
      : await env.AI.run(
        bindingModel as never,
        input as never,
        requestConfig.gatewayId
          ? ({ gateway: { id: requestConfig.gatewayId, metadata: options.metadata } } as never)
          : undefined,
      );
  return {
    content: extractText(result),
    model: modelFrom(result, bindingModel),
    usage: isRecord(result) ? usageFrom(result.usage) : undefined,
  };
};

export const runChatModel = async (
  env: Env,
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> => (await runChatCompletion(env, config, messages, options)).content;

const extractResponsesText = (result: unknown): string => {
  if (!isRecord(result)) {
    return extractText(result);
  }
  if (typeof result.output_text === "string") {
    return result.output_text;
  }

  const parts: string[] = [];
  const output = Array.isArray(result.output) ? result.output : [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n\n") || extractText(result);
};

const extractResponsesSources = (result: unknown): WebSearchSource[] => {
  if (!isRecord(result) || !Array.isArray(result.output)) {
    return [];
  }

  const sources = new Map<string, WebSearchSource>();
  for (const item of result.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (!isRecord(content) || !Array.isArray(content.annotations)) {
        continue;
      }
      for (const annotation of content.annotations) {
        if (!isRecord(annotation) || typeof annotation.url !== "string") {
          continue;
        }
        sources.set(annotation.url, {
          url: annotation.url,
          title: typeof annotation.title === "string" ? annotation.title : undefined,
        });
      }
    }
  }
  return [...sources.values()];
};

const extractChatCompletionSources = (result: unknown): WebSearchSource[] => {
  if (!isRecord(result) || !Array.isArray(result.choices)) {
    return [];
  }

  const sources = new Map<string, WebSearchSource>();
  for (const choice of result.choices) {
    if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.annotations)) {
      continue;
    }
    for (const annotation of choice.message.annotations) {
      if (!isRecord(annotation) || annotation.type !== "url_citation" || !isRecord(annotation.url_citation)) {
        continue;
      }
      const { url, title } = annotation.url_citation;
      if (typeof url === "string") {
        sources.set(url, {
          url,
          title: typeof title === "string" ? title : undefined,
        });
      }
    }
  }
  return [...sources.values()];
};

const countWebSearchCalls = (result: unknown) =>
  isRecord(result) && Array.isArray(result.output)
    ? result.output.filter((item) => isRecord(item) && item.type === "web_search_call").length
    : 0;

export const runWebSearchCompletion = async (
  env: Env,
  input: string,
  options: WebSearchChatOptions,
): Promise<WebSearchModelResult> => {
  const request = {
    input,
    instructions: options.instructions,
    max_output_tokens: options.maxOutputTokens,
    max_turns: options.maxTurns,
    temperature: options.temperature,
    tools: [{ type: "web_search", search_context_size: options.searchContextSize }],
  };

  const result = options.gatewayId
    ? await gatewayWebSearchChatCompletions(
      env,
      options.gatewayId,
      options.model,
      input,
      options.instructions,
      options.maxOutputTokens,
      options.searchContextSize,
      options.metadata,
    )
    : await env.AI.run(options.model, request, undefined);

  return {
    content: extractResponsesText(result),
    model: modelFrom(result, options.model),
    sources: [...extractResponsesSources(result), ...extractChatCompletionSources(result)],
    usage: isRecord(result) ? usageFrom(result.usage) : undefined,
    webSearchCalls: countWebSearchCalls(result),
  };
};

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
};
