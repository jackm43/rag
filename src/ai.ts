import type { BotConfig } from "./config";
import type { Env } from "./types";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type WebSearchContextSize = "low" | "medium" | "high";

const isWorkersAiModel = (model: string) => model.startsWith("@cf/");
const isGatewayWorkersAiModel = (model: string) => model.startsWith("workers-ai/");
const isBindingModel = (model: string) => isWorkersAiModel(model) || isGatewayWorkersAiModel(model);

const toBindingModel = (model: string) =>
  isGatewayWorkersAiModel(model) ? model.slice("workers-ai/".length) : model;

const objectFrom = (value: unknown) =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

const extractText = (result: unknown): string => {
  if (typeof result === "string") {
    return result;
  }
  const payload = objectFrom(result);
  if (!payload) {
    return "";
  }
  if (typeof payload.response === "string") {
    return payload.response;
  }
  const firstChoice = objectFrom(Array.isArray(payload.choices) ? payload.choices[0] : undefined);
  const message = objectFrom(firstChoice?.message);
  if (!message) {
    return "";
  }
  return typeof message.content === "string" ? message.content : "";
};

const optionalUsageNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const usageFrom = (usage: unknown) => {
  const payload = objectFrom(usage);
  return payload
    ? {
      promptTokens: optionalUsageNumber(payload.prompt_tokens ?? payload.input_tokens),
      completionTokens: optionalUsageNumber(payload.completion_tokens ?? payload.output_tokens),
      totalTokens: optionalUsageNumber(payload.total_tokens),
    }
    : undefined;
};

const errorDetailFrom = (payload: unknown, fallback: string) => {
  const body = objectFrom(payload);
  if (!body) {
    return fallback;
  }

  const error = body.error;
  if (Array.isArray(error)) {
    return error
      .map((item) => {
        const detail = objectFrom(item);
        return detail && typeof detail.message === "string" ? detail.message : null;
      })
      .filter((message): message is string => Boolean(message))
      .join("; ") || fallback;
  }
  if (typeof error === "string") {
    return error;
  }
  const errorObject = objectFrom(error);
  if (errorObject && typeof errorObject.message === "string") {
    return errorObject.message;
  }
  if (typeof body.message === "string") {
    return body.message;
  }
  if (typeof body.description === "string") {
    return body.description;
  }
  return fallback;
};

const modelFrom = (payload: unknown, fallback: string) => {
  const body = objectFrom(payload);
  return typeof body?.model === "string" ? body.model : fallback;
};

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
      ? await gatewayChatCompletions(env, requestConfig.gatewayId, model, messages, maxTokens, temperature)
      : await env.AI.run(
        bindingModel as never,
        input as never,
        requestConfig.gatewayId ? ({ gateway: { id: requestConfig.gatewayId } } as never) : undefined,
      );
  return {
    content: extractText(result),
    model: modelFrom(result, bindingModel),
    usage: usageFrom(objectFrom(result)?.usage),
  };
};

export const runChatModel = async (
  env: Env,
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> => (await runChatCompletion(env, config, messages, options)).content;

const extractResponsesText = (result: unknown): string => {
  const payload = objectFrom(result);
  if (!payload) {
    return extractText(result);
  }
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const parts: string[] = [];
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const outputItem = objectFrom(item);
    if (!outputItem || !Array.isArray(outputItem.content)) {
      continue;
    }
    for (const content of outputItem.content) {
      const contentItem = objectFrom(content);
      if (contentItem && typeof contentItem.text === "string") {
        parts.push(contentItem.text);
      }
    }
  }
  return parts.join("\n\n") || extractText(result);
};

const extractResponsesSources = (result: unknown): WebSearchSource[] => {
  const payload = objectFrom(result);
  if (!payload || !Array.isArray(payload.output)) {
    return [];
  }

  const sources = new Map<string, WebSearchSource>();
  for (const item of payload.output) {
    const outputItem = objectFrom(item);
    if (!outputItem || !Array.isArray(outputItem.content)) {
      continue;
    }
    for (const content of outputItem.content) {
      const contentItem = objectFrom(content);
      if (!contentItem || !Array.isArray(contentItem.annotations)) {
        continue;
      }
      for (const annotation of contentItem.annotations) {
        const citation = objectFrom(annotation);
        if (!citation || typeof citation.url !== "string") {
          continue;
        }
        sources.set(citation.url, {
          url: citation.url,
          title: typeof citation.title === "string" ? citation.title : undefined,
        });
      }
    }
  }
  return [...sources.values()];
};

const extractChatCompletionSources = (result: unknown): WebSearchSource[] => {
  const payload = objectFrom(result);
  if (!payload || !Array.isArray(payload.choices)) {
    return [];
  }

  const sources = new Map<string, WebSearchSource>();
  for (const choice of payload.choices) {
    const choiceItem = objectFrom(choice);
    const message = objectFrom(choiceItem?.message);
    if (!message || !Array.isArray(message.annotations)) {
      continue;
    }
    for (const annotation of message.annotations) {
      const citation = objectFrom(annotation);
      const urlCitation = objectFrom(citation?.url_citation);
      if (!citation || citation.type !== "url_citation" || !urlCitation) {
        continue;
      }
      const { url, title } = urlCitation;
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

const countWebSearchCalls = (result: unknown) => {
  const payload = objectFrom(result);
  return payload && Array.isArray(payload.output)
    ? payload.output.filter((item) => objectFrom(item)?.type === "web_search_call").length
    : 0;
};

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
    )
    : await env.AI.run(options.model, request, undefined);

  return {
    content: extractResponsesText(result),
    model: modelFrom(result, options.model),
    sources: [...extractResponsesSources(result), ...extractChatCompletionSources(result)],
    usage: usageFrom(objectFrom(result)?.usage),
    webSearchCalls: countWebSearchCalls(result),
  };
};

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
};
