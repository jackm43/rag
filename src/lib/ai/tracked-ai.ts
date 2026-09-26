import {
  runChatCompletion,
  runWebSearchCompletion,
  type ChatMessage,
  type ChatModelResult,
  type ChatOptions,
  type WebSearchChatOptions,
  type WebSearchModelResult,
} from "./ai";
import { buildAiGatewayMetadata } from "./ai-metadata";
import type { BotConfig } from "./config";
import { createAiSpendSourceId, recordAiSpendEvent } from "./spend";
import type { Env } from "../../env";

export type SpendAttribution = {
  kind: string;
  requesterUserId?: string | null;
  requesterUsername?: string | null;
  channelId?: string | null;
  messageId?: string | null;
};

const trackCompletion = async <T extends ChatModelResult>(
  env: Env, attribution: SpendAttribution,
  complete: (metadata: ReturnType<typeof buildAiGatewayMetadata>) => Promise<T>,
): Promise<T> => {
  const sourceId = createAiSpendSourceId();
  const result = await complete(buildAiGatewayMetadata({ ...attribution, requestId: sourceId }));
  await recordAiSpendEvent(env, {
    kind: attribution.kind, requesterUserId: attribution.requesterUserId,
    requesterUsername: attribution.requesterUsername, model: result.model, sourceId,
    promptTokens: result.usage?.promptTokens ?? null,
    completionTokens: result.usage?.completionTokens ?? null,
    totalTokens: result.usage?.totalTokens ?? null,
  });
  return result;
};

export const runTrackedChatCompletion = (
  env: Env, config: BotConfig, messages: ChatMessage[],
  options: SpendAttribution & Omit<ChatOptions, "metadata">,
): Promise<ChatModelResult> =>
  trackCompletion(env, options, (metadata) => runChatCompletion(env, config, messages, { ...options, metadata }));

export const runTrackedWebSearchCompletion = (
  env: Env, input: string, options: SpendAttribution & Omit<WebSearchChatOptions, "metadata">,
): Promise<WebSearchModelResult> =>
  trackCompletion(env, options, (metadata) => runWebSearchCompletion(env, input, { ...options, metadata }));
