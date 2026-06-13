import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";

import { ChatService } from "../../server/aigateway/v1/chat_service_pb";
import {
  errorMessage,
  logger,
  parseTraceparent,
  platformAuthenticator,
  protect,
  requireIdentity,
  type AuthPolicy,
  type Tracer,
} from "@platy/sdk";
import { assistantToolCallMessage, buildConnectors, runToolCalls } from "./connectors";
import {
  complete,
  GatewayError,
  listCatalogModels,
  streamComplete,
  type ChatMessage,
  type CompletionRequest,
  type StreamEvent,
  type UpstreamMessage,
} from "./gateway";
import type { Env } from "./types";

// Upper bound on connector round-trips per completion, so a model looping on
// tool calls cannot run away.
const MAX_TOOL_ROUNDS = 4;

const ROLES = new Set(["system", "user", "assistant"]);

const sanitizeMessages = (raw: ChatMessage[]): ChatMessage[] => {
  const messages = raw
    .map((message) => ({ role: message.role.trim(), content: message.content }))
    .filter((message) => ROLES.has(message.role) && message.content.length > 0);
  if (messages.length === 0) {
    throw new ConnectError("at least one non-empty message is required", Code.InvalidArgument);
  }
  return messages;
};

const buildRequest = (env: Env, request: { model: string; messages: ChatMessage[]; maxTokens: number; temperature: number }): Omit<CompletionRequest, "stream"> => ({
  model: request.model.trim() || env.AIG_DEFAULT_MODEL,
  messages: sanitizeMessages(request.messages),
  maxTokens: request.maxTokens,
  // Proto default for temperature is 0, which is a valid value; callers pass a
  // negative number to mean "use the provider default".
  temperature: request.temperature,
});

const toConnectError = (error: unknown): ConnectError => {
  if (error instanceof ConnectError) {
    return error;
  }
  if (error instanceof GatewayError) {
    const code = error.status === 429 ? Code.ResourceExhausted : Code.Unavailable;
    return new ConnectError(error.message, code);
  }
  return new ConnectError(errorMessage(error), Code.Internal);
};

export const registerAiGatewayServices = (router: ConnectRouter, env: Env, tracer: Tracer) => {
  // Accepts a normal audience-scoped STS token (CLI, chained services) and,
  // because this worker carries a service credential, a DPoP-bound gateway
  // session token from a dumb browser client (the SDK mints the audience token
  // via client-credentials chaining). All issuer/JWKS/credential wiring lives
  // in the SDK helper.
  const policy: AuthPolicy = { authenticate: platformAuthenticator(env, "aigateway") };
  const connectors = buildConnectors(env, tracer);

  router.service(
    ChatService,
    protect(
      ChatService,
      {
        complete: async (request, context) => {
          const identity = requireIdentity(context);
          const built = buildRequest(env, request);
          const parent = parseTraceparent(context.requestHeader.get("traceparent"));
          const start = Date.now();
          logger.info("ai_complete", {
            actor: identity.email ?? identity.subject,
            model: built.model,
            chain: identity.actorChain,
          });
          try {
            let messages: UpstreamMessage[] = built.messages;
            let tools = connectors.tools;
            const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            for (let round = 0; ; round += 1) {
              let result;
              try {
                result = await complete(env, { ...built, messages, tools, stream: false });
              } catch (error) {
                // Not every provider/model accepts the tools parameter; fall
                // back to a plain completion rather than failing the request.
                if (round > 0 || tools.length === 0 || !(error instanceof GatewayError)) {
                  throw error;
                }
                logger.warn("tools_unsupported_fallback", { model: built.model, error: error.message });
                tools = [];
                result = await complete(env, { ...built, messages, tools, stream: false });
              }
              totals.promptTokens += result.usage.promptTokens;
              totals.completionTokens += result.usage.completionTokens;
              totals.totalTokens += result.usage.totalTokens;
              if (result.toolCalls.length === 0 || round >= MAX_TOOL_ROUNDS) {
                return {
                  content: result.content,
                  model: result.model,
                  finishReason: result.finishReason,
                  usage: {
                    promptTokens: BigInt(totals.promptTokens),
                    completionTokens: BigInt(totals.completionTokens),
                    totalTokens: BigInt(totals.totalTokens),
                  },
                  durationMs: BigInt(Date.now() - start),
                };
              }
              messages = [
                ...messages,
                assistantToolCallMessage(result.content, result.toolCalls),
                ...(await runToolCalls(connectors, identity, result.toolCalls, parent)),
              ];
            }
          } catch (error) {
            throw toConnectError(error);
          }
        },
        streamComplete: async function* (request, context) {
          const identity = requireIdentity(context);
          const built = buildRequest(env, request);
          const parent = parseTraceparent(context.requestHeader.get("traceparent"));
          const start = Date.now();
          logger.info("ai_stream_complete", {
            actor: identity.email ?? identity.subject,
            model: built.model,
            chain: identity.actorChain,
          });
          try {
            let messages: UpstreamMessage[] = built.messages;
            let tools = connectors.tools;
            const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            for (let round = 0; ; round += 1) {
              let final: Extract<StreamEvent, { kind: "final" }> | null = null;
              let yielded = false;
              try {
                for await (const event of streamComplete(env, { ...built, messages, tools, stream: true })) {
                  if (event.kind === "delta") {
                    yielded = true;
                    yield { delta: event.delta, done: false };
                    continue;
                  }
                  final = event;
                }
              } catch (error) {
                // Tools-unsupported fallback, only when nothing streamed yet.
                if (round > 0 || yielded || tools.length === 0 || !(error instanceof GatewayError)) {
                  throw error;
                }
                logger.warn("tools_unsupported_fallback", { model: built.model, error: error.message });
                tools = [];
                for await (const event of streamComplete(env, { ...built, messages, tools, stream: true })) {
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
                  usage: {
                    promptTokens: BigInt(totals.promptTokens),
                    completionTokens: BigInt(totals.completionTokens),
                    totalTokens: BigInt(totals.totalTokens),
                  },
                  durationMs: BigInt(Date.now() - start),
                };
                return;
              }
              messages = [
                ...messages,
                assistantToolCallMessage(final.content, final.toolCalls),
                ...(await runToolCalls(connectors, identity, final.toolCalls, parent)),
              ];
            }
          } catch (error) {
            throw toConnectError(error);
          }
        },
        listModels: async (request, context) => {
          requireIdentity(context);
          try {
            const catalog = await listCatalogModels(env);
            const filter = request.filter.trim().toLowerCase();
            let models = filter
              ? catalog.filter((model) => model.id.toLowerCase().includes(filter))
              : catalog;
            if (request.limit > 0) {
              models = models.slice(0, request.limit);
            }
            return {
              models: models.map((model) => ({
                id: model.id,
                provider: model.provider,
                costIn: model.costIn,
                costOut: model.costOut,
              })),
              total: catalog.length,
            };
          } catch (error) {
            throw toConnectError(error);
          }
        },
      },
      policy,
    ),
  );
};
