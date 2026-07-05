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
import type { Env } from "../contracts";

export type SpendAttribution = {
  kind: string;
  requesterUserId?: string | null;
  requesterUsername?: string | null;
  channelId?: string | null;
  messageId?: string | null;
};

const recordCompletionSpend = async (
  env: Env,
  attribution: SpendAttribution,
  result: ChatModelResult,
  sourceId: string,
) => {
  await recordAiSpendEvent(env, {
    kind: attribution.kind,
    requesterUserId: attribution.requesterUserId,
    requesterUsername: attribution.requesterUsername,
    model: result.model,
    promptTokens: result.usage?.promptTokens ?? null,
    completionTokens: result.usage?.completionTokens ?? null,
    totalTokens: result.usage?.totalTokens ?? null,
    sourceId,
  });
};

export const runTrackedChatCompletion = async (
  env: Env,
  config: BotConfig,
  messages: ChatMessage[],
  options: SpendAttribution & Omit<ChatOptions, "metadata">,
): Promise<ChatModelResult> => {
  const { kind, requesterUserId, requesterUsername, channelId, messageId, ...chatOptions } = options;
  const spendSourceId = createAiSpendSourceId();
  const result = await runChatCompletion(env, config, messages, {
    ...chatOptions,
    metadata: buildAiGatewayMetadata({
      kind,
      requestId: spendSourceId,
      requesterUserId,
      channelId,
      messageId,
    }),
  });
  await recordCompletionSpend(env, { kind, requesterUserId, requesterUsername }, result, spendSourceId);
  return result;
};

export const runTrackedWebSearchCompletion = async (
  env: Env,
  input: string,
  options: SpendAttribution & Omit<WebSearchChatOptions, "metadata">,
): Promise<WebSearchModelResult> => {
  const { kind, requesterUserId, requesterUsername, channelId, messageId, ...searchOptions } = options;
  const spendSourceId = createAiSpendSourceId();
  const result = await runWebSearchCompletion(env, input, {
    ...searchOptions,
    metadata: buildAiGatewayMetadata({
      kind,
      requestId: spendSourceId,
      requesterUserId,
      channelId,
      messageId,
    }),
  });
  await recordCompletionSpend(env, { kind, requesterUserId, requesterUsername }, result, spendSourceId);
  return result;
};
