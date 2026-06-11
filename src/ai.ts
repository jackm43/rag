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

const chatInput = (
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  stream: boolean,
) => {
  const model = options.model ?? config.responseModel;
  const maxTokens = options.maxTokens ?? config.maxTokens;
  const temperature = options.temperature ?? config.temperature;
  if (isWorkersAiModel(model)) {
    return { model, input: { messages, max_tokens: maxTokens, temperature, stream } };
  }
  return { model, input: { messages, max_completion_tokens: maxTokens, temperature } };
};

const aiRunOptions = (config: BotConfig) =>
  config.gatewayId ? { gateway: { id: config.gatewayId } } : undefined;

export async function* parseWorkersAiStream(stream: ReadableStream): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) {
            continue;
          }
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            return;
          }
          try {
            const parsed = JSON.parse(payload) as { response?: string };
            if (typeof parsed.response === "string" && parsed.response.length > 0) {
              yield parsed.response;
            }
          } catch {
            continue;
          }
        }
      }
      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const runChatModel = async (
  env: Env,
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> => {
  const { model, input } = chatInput(config, messages, options, false);
  const result = await env.AI.run(model as never, input as never, aiRunOptions(config) as never);
  return extractText(result);
};

export async function* streamChatModel(
  env: Env,
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<string> {
  const { model, input } = chatInput(config, messages, options, true);
  if (!isWorkersAiModel(model)) {
    yield await runChatModel(env, config, messages, options);
    return;
  }

  const result = await env.AI.run(model as never, input as never, aiRunOptions(config) as never);
  const stream = result as unknown;
  if (stream && typeof stream === "object" && "getReader" in stream) {
    yield* parseWorkersAiStream(stream as ReadableStream);
    return;
  }
  yield extractText(result);
}

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
};
