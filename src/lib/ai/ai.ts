// Ragbot's chat workflows over the centralized inference seam. This module
// owns WHAT to ask (config-derived request parameters) and how to interpret
// the raw payloads (text extraction, usage, sources, sanitization); transport,
// credentials, and gateway routing live in ./inference.
import type { BotConfig } from "./config";
import {
  inferenceClient,
  toBindingModel,
  type ChatMessage,
  type InferenceMetadata,
  type WebSearchContextSize,
} from "./inference";
import type { Env } from "../../env";
import { isRecord } from "../contracts";

export type { ChatMessage, WebSearchContextSize } from "./inference";

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

const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : [];
const responseContent = (result: unknown) =>
  records(isRecord(result) ? result.output : undefined).flatMap((item) => records(item.content));

const extractResponsesText = (result: unknown): string => {
  if (isRecord(result) && typeof result.output_text === "string") return result.output_text;
  return responseContent(result).flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("\n\n")
    || extractText(result);
};

const citationSources = (annotations: Record<string, unknown>[]): WebSearchSource[] => {
  const sources = new Map<string, WebSearchSource>();
  for (const { url, title } of annotations) {
    if (typeof url === "string") sources.set(url, { url, title: typeof title === "string" ? title : undefined });
  }
  return [...sources.values()];
};

const extractResponsesSources = (result: unknown) =>
  citationSources(responseContent(result).flatMap((part) => records(part.annotations)));

const extractChatCompletionSources = (result: unknown) => citationSources(
  records(isRecord(result) ? result.choices : undefined)
    .flatMap((choice) => records(isRecord(choice.message) ? choice.message.annotations : undefined))
    .flatMap((annotation) => annotation.type === "url_citation" && isRecord(annotation.url_citation)
      ? [annotation.url_citation] : []),
);

const countWebSearchCalls = (result: unknown) =>
  isRecord(result) && Array.isArray(result.output)
    ? result.output.filter((item) => isRecord(item) && item.type === "web_search_call").length
    : 0;

export const runWebSearchCompletion = async (
  env: Env,
  input: string,
  options: WebSearchChatOptions,
): Promise<WebSearchModelResult> => {
  const result = await inferenceClient(env).webSearch({ ...options, input });

  return {
    content: extractResponsesText(result),
    model: modelFrom(result, options.model),
    sources: [...extractResponsesSources(result), ...extractChatCompletionSources(result)],
    usage: isRecord(result) ? usageFrom(result.usage) : undefined,
    webSearchCalls: countWebSearchCalls(result),
  };
};
