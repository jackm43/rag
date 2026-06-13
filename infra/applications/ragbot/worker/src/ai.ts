import type { BotConfig } from "./config";
import { chatServiceClient } from "./connector";
import type { Env } from "./types";
import type { Identity } from "@platy/sdk";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
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
    if (!trimmed || looksLikeSpeakerLine(trimmed)) {
      start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n");
};

export const sanitizeAiText = (value: string) =>
  stripLeadingSpeakerLines(value)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export type ChatOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type ChatModelResult = {
  content: string;
  model: string;
  durationMs: number;
};

export type ChatStreamChunk =
  | { done: false; delta: string }
  | { done: true; content: string; model: string; durationMs: number };

const toGatewayModel = (model: string): string =>
  model.startsWith("@cf/") ? `workers-ai/${model}` : model;

const completionRequest = (
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions,
) => ({
  model: toGatewayModel(options.model ?? config.responseModel),
  messages,
  maxTokens: options.maxTokens ?? config.maxTokens,
  temperature: options.temperature ?? config.temperature,
});

export const runChatModel = async (
  env: Env,
  identity: Identity,
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatModelResult> => {
  const response = await chatServiceClient(env, identity).complete(
    completionRequest(config, messages, options),
  );
  return {
    content: response.content,
    model: response.model,
    durationMs: Number(response.durationMs),
  };
};

export async function* streamChatModel(
  env: Env,
  identity: Identity,
  config: BotConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<ChatStreamChunk> {
  const stream = chatServiceClient(env, identity).streamComplete(
    completionRequest(config, messages, options),
  );
  for await (const chunk of stream) {
    if (chunk.done) {
      yield {
        done: true,
        content: chunk.content,
        model: chunk.model,
        durationMs: Number(chunk.durationMs),
      };
      return;
    }
    if (chunk.delta) {
      yield { done: false, delta: chunk.delta };
    }
  }
}

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
};
