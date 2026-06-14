import {
  errorMessage,
  logger,
  parseTraceparent,
  type Identity,
  type SpanContext,
  type Tracer,
} from "@platy/sdk";

import { assistantToolCallMessage, buildConnectors, runToolCalls } from "./connectors";
import {
  complete as completeGateway,
  GatewayError,
  listCatalogModels,
  streamComplete as streamGatewayComplete,
  type ChatMessage,
  type CompletionRequest,
  type StreamEvent,
  type UpstreamMessage,
} from "./gateway";
import type { Env } from "./types";

const MAX_TOOL_ROUNDS = 4;
const ROLES = new Set(["system", "user", "assistant"]);

export class HttpServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpServiceError";
  }
}

export type CompletionInput = {
  model?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
};

const sanitizeMessages = (raw: ChatMessage[] = []): ChatMessage[] => {
  const messages = raw
    .map((message) => ({ role: message.role.trim(), content: message.content }))
    .filter((message) => ROLES.has(message.role) && message.content.length > 0);
  if (messages.length === 0) {
    throw new HttpServiceError(400, "at least one non-empty message is required");
  }
  return messages;
};

const buildRequest = (env: Env, request: CompletionInput): Omit<CompletionRequest, "stream"> => ({
  model: request.model?.trim() || env.AIG_DEFAULT_MODEL,
  messages: sanitizeMessages(request.messages),
  maxTokens: request.maxTokens,
  temperature: request.temperature,
});

const mapError = (error: unknown): HttpServiceError => {
  if (error instanceof HttpServiceError) {
    return error;
  }
  if (error instanceof GatewayError) {
    return new HttpServiceError(error.status, error.message);
  }
  return new HttpServiceError(500, errorMessage(error));
};

type ConnectorSet = Awaited<ReturnType<typeof buildConnectors>>;

export const connectorLoader = (env: Env, tracer: Tracer) => {
  let connectorsPromise: Promise<ConnectorSet> | null = null;
  return () => {
    connectorsPromise ??= buildConnectors(env, tracer);
    return connectorsPromise;
  };
};

export const complete = async (
  env: Env,
  identity: Identity,
  loadConnectors: () => Promise<ConnectorSet>,
  input: CompletionInput,
  traceparent: string | null,
) => {
  const built = buildRequest(env, input);
  const parent = parseTraceparent(traceparent);
  const start = Date.now();
  logger.info("ai_complete", {
    actor: identity.email ?? identity.subject,
    model: built.model,
    chain: identity.actorChain,
  });

  try {
    let messages: UpstreamMessage[] = built.messages;
    const connectorSet = await loadConnectors();
    let tools = connectorSet.tools;
    const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (let round = 0; ; round += 1) {
      let result;
      try {
        result = await completeGateway(env, identity, { ...built, messages, tools, stream: false });
      } catch (error) {
        if (round > 0 || tools.length === 0 || !(error instanceof GatewayError)) {
          throw error;
        }
        logger.warn("tools_unsupported_fallback", { model: built.model, error: error.message });
        tools = [];
        result = await completeGateway(env, identity, { ...built, messages, tools, stream: false });
      }
      totals.promptTokens += result.usage.promptTokens;
      totals.completionTokens += result.usage.completionTokens;
      totals.totalTokens += result.usage.totalTokens;
      if (result.toolCalls.length === 0 || round >= MAX_TOOL_ROUNDS) {
        return {
          content: result.content,
          model: result.model,
          finishReason: result.finishReason,
          usage: totals,
          durationMs: Date.now() - start,
        };
      }
      messages = [
        ...messages,
        assistantToolCallMessage(result.content, result.toolCalls),
        ...(await runToolCalls(connectorSet, identity, result.toolCalls, parent)),
      ];
    }
  } catch (error) {
    throw mapError(error);
  }
};

export async function* streamComplete(
  env: Env,
  identity: Identity,
  loadConnectors: () => Promise<ConnectorSet>,
  input: CompletionInput,
  traceparent: string | null,
) {
  const built = buildRequest(env, input);
  const parent = parseTraceparent(traceparent);
  const start = Date.now();
  logger.info("ai_stream_complete", {
    actor: identity.email ?? identity.subject,
    model: built.model,
    chain: identity.actorChain,
  });

  try {
    let messages: UpstreamMessage[] = built.messages;
    const connectorSet = await loadConnectors();
    let tools = connectorSet.tools;
    const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (let round = 0; ; round += 1) {
      let final: Extract<StreamEvent, { kind: "final" }> | null = null;
      let yielded = false;
      try {
        for await (const event of streamGatewayComplete(env, identity, { ...built, messages, tools, stream: true })) {
          if (event.kind === "delta") {
            yielded = true;
            yield { delta: event.delta, done: false };
            continue;
          }
          final = event;
        }
      } catch (error) {
        if (round > 0 || yielded || tools.length === 0 || !(error instanceof GatewayError)) {
          throw error;
        }
        logger.warn("tools_unsupported_fallback", { model: built.model, error: error.message });
        tools = [];
        for await (const event of streamGatewayComplete(env, identity, { ...built, messages, tools, stream: true })) {
          if (event.kind === "delta") {
            yield { delta: event.delta, done: false };
            continue;
          }
          final = event;
        }
      }
      if (!final) {
        throw new GatewayError("stream ended without a final event", 502);
      }
      totals.promptTokens += final.usage.promptTokens;
      totals.completionTokens += final.usage.completionTokens;
      totals.totalTokens += final.usage.totalTokens;
      if (final.toolCalls.length === 0 || round >= MAX_TOOL_ROUNDS) {
        yield {
          delta: "",
          done: true,
          content: final.content,
          model: final.model,
          finishReason: final.finishReason,
          usage: totals,
          durationMs: Date.now() - start,
        };
        return;
      }
      messages = [
        ...messages,
        assistantToolCallMessage(final.content, final.toolCalls),
        ...(await runToolCalls(connectorSet, identity, final.toolCalls, parent)),
      ];
    }
  } catch (error) {
    throw mapError(error);
  }
}

export const listModels = async (env: Env, identity: Identity, filterInput = "", limitInput = 0) => {
  try {
    const catalog = await listCatalogModels(env, identity);
    const filter = filterInput.trim().toLowerCase();
    let models = filter
      ? catalog.filter((model) => model.id.toLowerCase().includes(filter))
      : catalog;
    if (limitInput > 0) {
      models = models.slice(0, limitInput);
    }
    return { models, total: catalog.length };
  } catch (error) {
    throw mapError(error);
  }
};

