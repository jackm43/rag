// Ragbot's chat workflows over the centralized inference seam. This module
// owns WHAT to ask (config-derived request parameters) and how to interpret
// the raw payloads (text extraction, usage, sources, sanitization); transport,
// credentials, and gateway routing live in packages/inference.
import type { BotConfig } from "./config";
import {
  inferenceClient,
  toBindingModel,
  type ChatMessage,
  type InferenceMetadata,
  type WebSearchContextSize,
} from "../inference";
import type { Env } from "../contracts/types";
import { isRecord } from "../contracts/validation";

export type { ChatMessage, WebSearchContextSize } from "../inference";

export type AiGatewayMetadata = InferenceMetadata;

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

const modelFrom = (payload: unknown, fallback: string) =>
  isRecord(payload) && typeof payload.model === "string" ? payload.model : fallback;

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

  const result = await inferenceClient(env).chat({
    model,
    messages,
    maxTokens: options.maxTokens ?? config.maxTokens,
    temperature: options.temperature ?? config.temperature,
    gatewayId: options.gatewayId ?? config.gatewayId,
    metadata: options.metadata,
  });
  return {
    content: extractText(result),
    model: modelFrom(result, toBindingModel(model)),
    usage: isRecord(result) ? usageFrom(result.usage) : undefined,
  };
};

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
  const result = await inferenceClient(env).webSearch({
    model: options.model,
    input,
    instructions: options.instructions,
    maxOutputTokens: options.maxOutputTokens,
    maxTurns: options.maxTurns,
    temperature: options.temperature,
    searchContextSize: options.searchContextSize,
    gatewayId: options.gatewayId,
    metadata: options.metadata,
  });

  return {
    content: extractResponsesText(result),
    model: modelFrom(result, options.model),
    sources: [...extractResponsesSources(result), ...extractChatCompletionSources(result)],
    usage: isRecord(result) ? usageFrom(result.usage) : undefined,
    webSearchCalls: countWebSearchCalls(result),
  };
};
