import {
  errorMessage,
  logger,
  type Identity,
} from "@platy/sdk";

import { CONFIG_DEFAULTS, deleteSetting, getSettings, isConfigKey, setSetting } from "./config";
import { CommunityConfigError, requireCommunityConfigKey } from "./community-config";
import { postChannelMessage } from "./discord";
import { recordChannelChatInteraction, runChannelChat, streamChannelChat, type ChannelChatInput } from "./mention";
import { ensureRagbotSchema } from "./schema";
import type { Env } from "./types";

export class HttpServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpServiceError";
  }
}

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
    throw new HttpServiceError(400, `unknown config key ${key}`);
  }
  return key;
};

export const listConfig = async (env: Env) => {
  const settings = await getSettings(env);
  return {
    entries: Object.entries(CONFIG_DEFAULTS).map(([key, fallback]) => ({
      key,
      value: settings[key] ?? fallback,
      defaultValue: fallback,
      overridden: key in settings,
    })),
  };
};

export const getConfig = async (env: Env, key: string) => ({
  entry: await configEntry(env, requireConfigKey(key)),
});

export const updateConfig = async (env: Env, identity: Identity, key: string, value: string) => {
  const checkedKey = requireConfigKey(key);
  try {
    requireCommunityConfigKey(identity, checkedKey);
  } catch (error) {
    if (error instanceof CommunityConfigError) {
      throw new HttpServiceError(403, error.message);
    }
    throw error;
  }
  await setSetting(env, checkedKey, value);
  logger.info("config_updated", { key: checkedKey, actor: identity.email ?? identity.subject });
  return { entry: await configEntry(env, checkedKey) };
};

export const resetConfig = async (env: Env, identity: Identity, key: string) => {
  const checkedKey = requireConfigKey(key);
  try {
    requireCommunityConfigKey(identity, checkedKey);
  } catch (error) {
    if (error instanceof CommunityConfigError) {
      throw new HttpServiceError(403, error.message);
    }
    throw error;
  }
  await deleteSetting(env, checkedKey);
  logger.info("config_reset", { key: checkedKey, actor: identity.email ?? identity.subject });
  return { entry: await configEntry(env, checkedKey) };
};

export const queryDatabase = async (
  env: Env,
  identity: Identity,
  sql: string,
  params: unknown[] = [],
) => {
  const statementText = sql.trim();
  if (!statementText) {
    throw new HttpServiceError(400, "sql is required");
  }
  logger.info("admin_db_query", { actor: identity.email ?? identity.subject });
  try {
    const statement = env.DB.prepare(statementText);
    const bound = params.length ? statement.bind(...params) : statement;
    const result = await bound.all();
    return {
      rows: result.results ?? [],
      meta: result.meta ?? {},
    };
  } catch (error) {
    throw new HttpServiceError(400, errorMessage(error));
  }
};

export const listInteractions = async (env: Env, limitInput = 20) => {
  await ensureRagbotSchema(env);
  const limit = Math.min(Math.max(limitInput || 20, 1), 100);
  const result = await env.DB.prepare(
    "SELECT id, kind, channel_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, created_at, prompt_tokens, completion_tokens, total_tokens FROM rag_ai_interactions ORDER BY id DESC LIMIT ?",
  )
    .bind(limit)
    .run<Record<string, unknown>>();
  return {
    interactions: (result.results ?? []).map((row) => ({
      id: Number(row.id ?? 0),
      kind: String(row.kind ?? ""),
      channelId: String(row.channel_id ?? ""),
      requesterUsername: String(row.requester_username ?? ""),
      prompt: String(row.prompt ?? ""),
      responseText: String(row.response_text ?? ""),
      model: String(row.model ?? ""),
      aiDurationMs: Number(row.ai_duration_ms ?? 0),
      totalDurationMs: Number(row.total_duration_ms ?? 0),
      status: String(row.status ?? ""),
      errorMessage: String(row.error_message ?? ""),
      createdAt: String(row.created_at ?? ""),
      promptTokens: Number(row.prompt_tokens ?? 0),
      completionTokens: Number(row.completion_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
    })),
  };
};

export const listTotals = async (env: Env, limitInput = 25) => {
  const limit = Math.min(Math.max(limitInput || 25, 1), 100);
  const result = await env.DB.prepare(
    "SELECT ragged_user_id, ragged_username, rag_count, updated_at FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT ?",
  )
    .bind(limit)
    .run<Record<string, unknown>>();
  return {
    totals: (result.results ?? []).map((row) => ({
      userId: String(row.ragged_user_id ?? ""),
      username: String(row.ragged_username ?? ""),
      ragCount: Number(row.rag_count ?? 0),
      updatedAt: String(row.updated_at ?? ""),
    })),
  };
};

const callGatewayControl = async (env: Env, path: string, method: string) => {
  const id = env.DISCORD_GATEWAY.idFromName("discord-gateway");
  const response = await env.DISCORD_GATEWAY.get(id).fetch(
    new Request(`https://discord-gateway${path}`, { method }),
  );
  if (!response.ok) {
    throw new HttpServiceError(503, `gateway control failed with status ${response.status}`);
  }
  return response.json();
};

export const getGatewayHealth = async (env: Env) => ({
  state: await callGatewayControl(env, "/gateway/health", "GET"),
});

export const startGateway = async (env: Env, identity: Identity) => {
  logger.info("gateway_start_requested", { actor: identity.email ?? identity.subject });
  return {
    state: await callGatewayControl(env, "/gateway/start", "POST"),
  };
};

export interface ChatRequest {
  prompt: string;
  requesterUsername?: string;
  channelId?: string;
  messageId?: string;
  replyContext?: string;
  postToChannel?: boolean;
}

const chatInput = (identity: Identity, request: ChatRequest): ChannelChatInput => {
  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new HttpServiceError(400, "prompt is required");
  }
  return {
    kind: request.postToChannel ? "channel" : "rpc",
    channelId: request.channelId ?? "",
    messageId: request.messageId ?? "",
    requesterUserId: identity.subject,
    requesterUsername: request.requesterUsername?.trim() || identity.email?.split("@")[0] || "operator",
    prompt,
    replyContext: request.replyContext ?? "",
  };
};

export const chat = async (env: Env, identity: Identity, request: ChatRequest) => {
  const input = chatInput(identity, request);
  logger.info("chat_requested", {
    actor: identity.email ?? identity.subject,
    channelId: input.channelId || undefined,
    postToChannel: Boolean(request.postToChannel),
  });
  const result = await runChannelChat(env, identity, input);
  await maybePostChatResult(env, input, request, result.responseText, result);
  return {
    responseText: result.responseText,
    model: result.model,
    aiDurationMs: result.aiDurationMs,
    totalDurationMs: result.totalDurationMs,
  };
};

export async function* streamChat(env: Env, identity: Identity, request: ChatRequest) {
  const input = chatInput(identity, request);
  logger.info("stream_chat_requested", {
    actor: identity.email ?? identity.subject,
    channelId: input.channelId || undefined,
    postToChannel: Boolean(request.postToChannel),
  });

  let finalChunk: {
    responseText: string;
    model: string;
    aiDurationMs: number;
    totalDurationMs: number;
  } | null = null;

  for await (const chunk of streamChannelChat(env, identity, input)) {
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
    throw new HttpServiceError(500, "stream ended without a final chunk");
  }

  await maybePostChatResult(env, input, request, finalChunk.responseText, finalChunk);
  yield { delta: "", done: true, ...finalChunk };
}

const maybePostChatResult = async (
  env: Env,
  input: ChannelChatInput,
  request: ChatRequest,
  responseText: string,
  result: { responseText: string; model: string; aiDurationMs: number; totalDurationMs: number },
) => {
  if (!request.postToChannel) {
    await recordChannelChatInteraction(env, input, result, "ok", null);
    return;
  }
  if (!request.channelId) {
    throw new HttpServiceError(400, "channelId is required when postToChannel is true");
  }
  const response = await postChannelMessage(env, request.channelId, responseText);
  if (!response.ok) {
    await recordChannelChatInteraction(
      env,
      input,
      result,
      `discord_${response.status}`,
      await response.text().catch(() => null),
    );
    throw new HttpServiceError(503, `discord post failed with status ${response.status}`);
  }
  await recordChannelChatInteraction(env, input, result, "ok", null);
};
