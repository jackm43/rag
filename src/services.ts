import { toJson, type JsonObject } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";

import {
  ChatService,
  ConfigService,
  DatabaseService,
  GatewayControlService,
  InteractionService,
  LeaderboardService,
} from "../infra/applications/ragbot/server/ragbot/v1/ragbot_pb";
import {
  errorMessage,
  logger,
  protect,
  requireIdentity,
  stsAuthenticator,
  type AuthPolicy,
} from "../infra/sdk/ts/src";
import { CONFIG_DEFAULTS, deleteSetting, getSettings, isConfigKey, setSetting } from "./config";
import { postChannelMessage } from "./discord";
import { recordChannelChatInteraction, runChannelChat, streamChannelChat, type ChannelChatInput } from "./mention";
import type { Env } from "./types";

const configEntry = async (env: Env, key: keyof typeof CONFIG_DEFAULTS) => {
  const settings = await getSettings(env);
  return {
    key,
    value: settings[key] ?? CONFIG_DEFAULTS[key],
    defaultValue: CONFIG_DEFAULTS[key],
    overridden: key in settings,
  };
};

const requireConfigKey = (key: string) => {
  if (!isConfigKey(key)) {
    throw new ConnectError(`unknown config key ${key}`, Code.InvalidArgument);
  }
  return key;
};

const callGatewayControl = async (env: Env, path: string, method: string) => {
  const id = env.DISCORD_GATEWAY.idFromName("discord-gateway");
  const response = await env.DISCORD_GATEWAY.get(id).fetch(
    new Request(`https://discord-gateway${path}`, { method }),
  );
  if (!response.ok) {
    throw new ConnectError(`gateway control failed with status ${response.status}`, Code.Unavailable);
  }
  return (await response.json()) as JsonObject;
};

export const registerRagbotServices = (router: ConnectRouter, env: Env) => {
  const issuer = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
  const policy: AuthPolicy = {
    authenticate: stsAuthenticator({
      issuer,
      audience: "ragbot",
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      jwksFetch: env.AUTH_GATEWAY
        ? (input, init) => env.AUTH_GATEWAY!.fetch(input, init)
        : undefined,
    }),
  };

  router.service(
    ConfigService,
    protect(
      ConfigService,
      {
        listConfig: async () => {
          const settings = await getSettings(env);
          return {
            entries: Object.entries(CONFIG_DEFAULTS).map(([key, fallback]) => ({
              key,
              value: settings[key] ?? fallback,
              defaultValue: fallback,
              overridden: key in settings,
            })),
          };
        },
        getConfig: async (request) => ({
          entry: await configEntry(env, requireConfigKey(request.key)),
        }),
        updateConfig: async (request, context) => {
          const identity = requireIdentity(context);
          const key = requireConfigKey(request.key);
          await setSetting(env, key, request.value);
          logger.info("config_updated", { key, actor: identity.email ?? identity.subject });
          return { entry: await configEntry(env, key) };
        },
        resetConfig: async (request, context) => {
          const identity = requireIdentity(context);
          const key = requireConfigKey(request.key);
          await deleteSetting(env, key);
          logger.info("config_reset", { key, actor: identity.email ?? identity.subject });
          return { entry: await configEntry(env, key) };
        },
      },
      policy,
    ),
  );

  router.service(
    DatabaseService,
    protect(
      DatabaseService,
      {
        query: async (request, context) => {
          const identity = requireIdentity(context);
          const sql = request.sql.trim();
          if (!sql) {
            throw new ConnectError("sql is required", Code.InvalidArgument);
          }
          logger.info("admin_db_query", { actor: identity.email ?? identity.subject });
          try {
            const statement = env.DB.prepare(sql);
            const params = request.params.map((value) => toJson(ValueSchema, value));
            const bound = params.length ? statement.bind(...params) : statement;
            const result = await bound.all();
            return {
              rows: (result.results ?? []).map((row) => row as JsonObject),
              meta: (result.meta ?? {}) as JsonObject,
            };
          } catch (error) {
            throw new ConnectError(errorMessage(error), Code.InvalidArgument);
          }
        },
      },
      policy,
    ),
  );

  router.service(
    InteractionService,
    protect(
      InteractionService,
      {
        listInteractions: async (request) => {
          const limit = Math.min(Math.max(request.limit || 20, 1), 100);
          const result = await env.DB.prepare(
            "SELECT id, kind, channel_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, created_at FROM rag_ai_interactions ORDER BY id DESC LIMIT ?",
          )
            .bind(limit)
            .run<Record<string, unknown>>();
          return {
            interactions: (result.results ?? []).map((row) => ({
              id: BigInt((row.id as number) ?? 0),
              kind: String(row.kind ?? ""),
              channelId: String(row.channel_id ?? ""),
              requesterUsername: String(row.requester_username ?? ""),
              prompt: String(row.prompt ?? ""),
              responseText: String(row.response_text ?? ""),
              model: String(row.model ?? ""),
              aiDurationMs: BigInt((row.ai_duration_ms as number) ?? 0),
              totalDurationMs: BigInt((row.total_duration_ms as number) ?? 0),
              status: String(row.status ?? ""),
              errorMessage: String(row.error_message ?? ""),
              createdAt: String(row.created_at ?? ""),
            })),
          };
        },
      },
      policy,
    ),
  );

  router.service(
    ChatService,
    protect(
      ChatService,
      {
        chat: async (request, context) => {
          const identity = requireIdentity(context);
          const prompt = request.prompt.trim();
          if (!prompt) {
            throw new ConnectError("prompt is required", Code.InvalidArgument);
          }

          const requesterUsername =
            request.requesterUsername.trim() ||
            identity.email?.split("@")[0] ||
            "operator";

          logger.info("chat_requested", {
            actor: identity.email ?? identity.subject,
            channelId: request.channelId || undefined,
            postToChannel: request.postToChannel,
          });

          const chatInput: ChannelChatInput = {
            kind: request.postToChannel ? "channel" : "rpc",
            channelId: request.channelId,
            messageId: request.messageId,
            requesterUserId: identity.subject,
            requesterUsername,
            prompt,
            replyContext: request.replyContext,
          };

          try {
            const result = await runChannelChat(env, chatInput);

            if (request.postToChannel) {
              if (!request.channelId) {
                throw new ConnectError("channel_id is required when post_to_channel is true", Code.InvalidArgument);
              }
              const response = await postChannelMessage(env, request.channelId, result.responseText);
              if (!response.ok) {
                await recordChannelChatInteraction(
                  env,
                  chatInput,
                  result,
                  `discord_${response.status}`,
                  await response.text().catch(() => null),
                );
                throw new ConnectError(
                  `discord post failed with status ${response.status}`,
                  Code.Unavailable,
                );
              }
            }

            await recordChannelChatInteraction(env, chatInput, result, "ok", null);

            return {
              responseText: result.responseText,
              model: result.model,
              aiDurationMs: BigInt(result.aiDurationMs),
              totalDurationMs: BigInt(result.totalDurationMs),
            };
          } catch (error) {
            if (error instanceof ConnectError) {
              throw error;
            }
            throw new ConnectError(errorMessage(error), Code.Internal);
          }
        },
        streamChat: async function* (request, context) {
          const identity = requireIdentity(context);
          const prompt = request.prompt.trim();
          if (!prompt) {
            throw new ConnectError("prompt is required", Code.InvalidArgument);
          }

          const requesterUsername =
            request.requesterUsername.trim() ||
            identity.email?.split("@")[0] ||
            "operator";

          logger.info("stream_chat_requested", {
            actor: identity.email ?? identity.subject,
            channelId: request.channelId || undefined,
            postToChannel: request.postToChannel,
          });

          const chatInput: ChannelChatInput = {
            kind: request.postToChannel ? "channel" : "rpc",
            channelId: request.channelId,
            messageId: request.messageId,
            requesterUserId: identity.subject,
            requesterUsername,
            prompt,
            replyContext: request.replyContext,
          };

          try {
            let finalChunk: {
              responseText: string;
              model: string;
              aiDurationMs: number;
              totalDurationMs: number;
            } | null = null;

            for await (const chunk of streamChannelChat(env, chatInput)) {
              if (chunk.done) {
                finalChunk = {
                  responseText: chunk.responseText ?? "",
                  model: chunk.model ?? "",
                  aiDurationMs: chunk.aiDurationMs ?? 0,
                  totalDurationMs: chunk.totalDurationMs ?? 0,
                };
                break;
              }
              yield { delta: chunk.delta, done: false };
            }

            if (!finalChunk) {
              throw new ConnectError("stream ended without a final chunk", Code.Internal);
            }

            if (request.postToChannel) {
              if (!request.channelId) {
                throw new ConnectError("channel_id is required when post_to_channel is true", Code.InvalidArgument);
              }
              const response = await postChannelMessage(env, request.channelId, finalChunk.responseText);
              if (!response.ok) {
                await recordChannelChatInteraction(
                  env,
                  chatInput,
                  finalChunk,
                  `discord_${response.status}`,
                  await response.text().catch(() => null),
                );
                throw new ConnectError(
                  `discord post failed with status ${response.status}`,
                  Code.Unavailable,
                );
              }
            }

            await recordChannelChatInteraction(env, chatInput, finalChunk, "ok", null);

            yield {
              delta: "",
              done: true,
              responseText: finalChunk.responseText,
              model: finalChunk.model,
              aiDurationMs: BigInt(finalChunk.aiDurationMs),
              totalDurationMs: BigInt(finalChunk.totalDurationMs),
            };
          } catch (error) {
            if (error instanceof ConnectError) {
              throw error;
            }
            throw new ConnectError(errorMessage(error), Code.Internal);
          }
        },
      },
      policy,
    ),
  );

  router.service(
    LeaderboardService,
    protect(
      LeaderboardService,
      {
        listTotals: async (request) => {
          const limit = Math.min(Math.max(request.limit || 25, 1), 100);
          const result = await env.DB.prepare(
            "SELECT ragged_user_id, ragged_username, rag_count, updated_at FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT ?",
          )
            .bind(limit)
            .run<Record<string, unknown>>();
          return {
            totals: (result.results ?? []).map((row) => ({
              userId: String(row.ragged_user_id ?? ""),
              username: String(row.ragged_username ?? ""),
              ragCount: BigInt((row.rag_count as number) ?? 0),
              updatedAt: String(row.updated_at ?? ""),
            })),
          };
        },
      },
      policy,
    ),
  );

  router.service(
    GatewayControlService,
    protect(
      GatewayControlService,
      {
        getHealth: async () => ({
          state: await callGatewayControl(env, "/gateway/health", "GET"),
        }),
        startGateway: async (_request, context) => {
          const identity = requireIdentity(context);
          logger.info("gateway_start_requested", { actor: identity.email ?? identity.subject });
          return {
            state: await callGatewayControl(env, "/gateway/start", "POST"),
          };
        },
      },
      policy,
    ),
  );
};
