// The local debugging UI worker. Local only (wrangler.dev.jsonc, `pnpm run
// dev:ui`): serves the single-page UI and a small JSON API that feeds synthetic
// Discord events into the real bot code (see ./harness.ts).
import { commands } from "../src/commands";
import { isRecord } from "../src/lib/contracts";
import { jsonResponse } from "../src/lib/http";
import { errorMessage } from "../src/lib/logger";
import { RAG_ADMIN_USER_IDS } from "../src/structs/registry";
import { d1Select, kvKeys, kvText, ProdAccessError } from "./cloudflare-api";
import type { DevEnv } from "./env";
import {
  probeModel,
  resolveDevConfig,
  simulateInteraction,
  simulateMention,
  type ConfigOverrides,
  type InteractionSimulationInput,
  type MentionSimulationInput,
} from "./harness";
import { loadModelCatalog } from "./models";
import appJs from "./ui/app.client.js";
import appCss from "./ui/app.css";
import indexHtml from "./ui/index.html";

const PROD_INTERACTION_COLUMNS =
  "id, kind, channel_id, message_id, requester_user_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, prompt_tokens, completion_tokens, total_tokens, created_at";
const MAX_LIST_LIMIT = 200;

const text = (body: string, contentType: string) =>
  new Response(body, { headers: { "content-type": contentType, "cache-control": "no-store" } });

const clampLimit = (value: string | null, fallback = 50) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIST_LIMIT) : fallback;
};

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    throw new HttpError(400, "expected a JSON object body");
  }
  return body;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const requireString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${key} is required`);
  }
  return value;
};

const requireIdentity = (value: unknown) => {
  if (!isRecord(value) || typeof value.userId !== "string" || typeof value.username !== "string") {
    throw new HttpError(400, "identity requires userId and username");
  }
  return {
    userId: value.userId,
    username: value.username,
    globalName: typeof value.globalName === "string" ? value.globalName : null,
    nick: typeof value.nick === "string" ? value.nick : null,
  };
};

const overridesFrom = (value: unknown): ConfigOverrides => {
  if (!isRecord(value)) {
    return {};
  }
  const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : undefined);
  const kv = isRecord(value.kv)
    ? Object.fromEntries(Object.entries(value.kv).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return {
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined,
    webSearchModel:
      typeof value.webSearchModel === "string" && value.webSearchModel.trim() ? value.webSearchModel.trim() : undefined,
    temperature: number(value.temperature),
    maxTokens: number(value.maxTokens),
    historyLimit: number(value.historyLimit),
    kv,
  };
};

const mentionInputFrom = (env: DevEnv, body: Record<string, unknown>): MentionSimulationInput => {
  const mode = body.mode === "thread" || body.mode === "ask_thread" ? body.mode : "channel";
  const transcript = Array.isArray(body.transcript)
    ? body.transcript.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" && typeof entry.content === "string"
        ? [{
          id: entry.id,
          role: entry.role === "bot" ? ("bot" as const) : ("user" as const),
          content: entry.content,
          ...(isRecord(entry.author) ? { author: requireIdentity(entry.author) } : {}),
        }]
        : [])
    : [];
  return {
    content: requireString(body, "content"),
    mentionBot: body.mentionBot !== false,
    identity: requireIdentity(body.identity),
    botUserId: typeof body.botUserId === "string" && body.botUserId ? body.botUserId : env.DISCORD_APPLICATION_ID,
    guildId: typeof body.guildId === "string" && body.guildId ? body.guildId : defaultGuildId(env),
    channelId: requireString(body, "channelId"),
    mode,
    transcript,
    replyToId: typeof body.replyToId === "string" && body.replyToId ? body.replyToId : undefined,
    overrides: overridesFrom(body.overrides),
  };
};

const interactionInputFrom = (env: DevEnv, body: Record<string, unknown>): InteractionSimulationInput => {
  const options = Array.isArray(body.options)
    ? body.options.flatMap((option) =>
      isRecord(option) && typeof option.name === "string" && typeof option.type === "number"
        ? [{ name: option.name, type: option.type, value: String(option.value ?? "") }]
        : [])
    : [];
  const resolvedUsers = isRecord(body.resolvedUsers)
    ? Object.fromEntries(Object.entries(body.resolvedUsers).map(([id, user]) => [id, requireIdentity(user)]))
    : undefined;
  return {
    command: requireString(body, "command"),
    options,
    resolvedUsers,
    identity: requireIdentity(body.identity),
    guildId: typeof body.guildId === "string" && body.guildId ? body.guildId : defaultGuildId(env),
    channelId: requireString(body, "channelId"),
    overrides: overridesFrom(body.overrides),
  };
};

const defaultGuildId = (env: DevEnv) => (env.ALLOWED_GUILD_IDS ?? "").split(",")[0]?.trim() ?? "";

const meta = async (env: DevEnv) => ({
  applicationId: env.DISCORD_APPLICATION_ID,
  accountId: env.CF_ACCOUNT_ID,
  gatewayId: env.CF_AIG_GATEWAY_ID,
  guildId: defaultGuildId(env),
  allowedGuildIds: env.ALLOWED_GUILD_IDS ?? "",
  adminUserIds: RAG_ADMIN_USER_IDS,
  hasAigToken: Boolean(env.CF_AIG_TOKEN),
  hasProdAccess: Boolean(env.CLOUDFLARE_API_TOKEN),
  config: await resolveDevConfig({}),
  commands: [...commands.values()].map((command) => ({
    ...command.data.toJSON(),
    adminOnly: Boolean(command.adminOnly),
    aiLimited: Boolean(command.aiLimited),
  })),
});

const prodInteractions = async (env: DevEnv, url: URL) => {
  const limit = clampLimit(url.searchParams.get("limit"));
  const kinds = (url.searchParams.get("kind") ?? "")
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (kinds.length > 0) {
    clauses.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  if (query) {
    clauses.push("(prompt LIKE ? OR requester_username LIKE ? OR response_text LIKE ?)");
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  return d1Select(env, `SELECT ${PROD_INTERACTION_COLUMNS} FROM rag_ai_interactions${where} ORDER BY id DESC LIMIT ?`, params);
};

const prodConfig = async (env: DevEnv) => {
  const keys = await kvKeys(env);
  const values: Record<string, string> = {};
  await Promise.all(
    keys.map(async (key) => {
      const value = await kvText(env, key);
      if (value !== null) {
        values[key] = value;
      }
    }),
  );
  return { keys, values, fetchedAt: new Date().toISOString() };
};

const localInteractions = async (env: DevEnv, url: URL) => {
  const limit = clampLimit(url.searchParams.get("limit"));
  const rows = await env.DB.prepare(`SELECT ${PROD_INTERACTION_COLUMNS} FROM rag_ai_interactions ORDER BY id DESC LIMIT ?`)
    .bind(limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
};

const resetLocalLimits = async (env: DevEnv) => {
  const result = await env.DB.prepare("DELETE FROM rag_ai_requests").run();
  return { deleted: result.meta.changes ?? 0 };
};

const route = async (request: Request, env: DevEnv): Promise<Response> => {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/") {
    return text(indexHtml, "text/html; charset=utf-8");
  }
  if (method === "GET" && pathname === "/app.css") {
    return text(appCss, "text/css; charset=utf-8");
  }
  if (method === "GET" && pathname === "/app.client.js") {
    return text(appJs, "text/javascript; charset=utf-8");
  }

  if (method === "GET" && pathname === "/api/meta") {
    return jsonResponse(await meta(env));
  }
  if (method === "GET" && pathname === "/api/models") {
    return jsonResponse(await loadModelCatalog(env, url.searchParams.get("refresh") === "1"));
  }
  if (method === "POST" && pathname === "/api/models/probe") {
    if (!env.CF_AIG_TOKEN) {
      throw new HttpError(503, "CF_AIG_TOKEN is not set for the dev worker; restart via `pnpm run dev:ui`.");
    }
    const body = await readJson(request);
    return jsonResponse(await probeModel(env, requireString(body, "model")));
  }
  if (method === "POST" && pathname === "/api/config") {
    const body = await readJson(request);
    return jsonResponse(await resolveDevConfig(overridesFrom(body.overrides)));
  }
  if (method === "POST" && pathname === "/api/mention") {
    if (!env.CF_AIG_TOKEN) {
      throw new HttpError(503, "CF_AIG_TOKEN is not set for the dev worker; restart via `pnpm run dev:ui`.");
    }
    return jsonResponse(await simulateMention(env, mentionInputFrom(env, await readJson(request))));
  }
  if (method === "POST" && pathname === "/api/interaction") {
    return jsonResponse(await simulateInteraction(env, interactionInputFrom(env, await readJson(request))));
  }
  if (method === "GET" && pathname === "/api/prod/interactions") {
    return jsonResponse({ rows: await prodInteractions(env, url) });
  }
  if (method === "GET" && pathname === "/api/prod/config") {
    return jsonResponse(await prodConfig(env));
  }
  if (method === "GET" && pathname === "/api/local/interactions") {
    return jsonResponse({ rows: await localInteractions(env, url) });
  }
  if (method === "POST" && pathname === "/api/local/reset-limits") {
    return jsonResponse(await resetLocalLimits(env));
  }

  return new Response("Not found", { status: 404 });
};

export default {
  async fetch(request: Request, env: DevEnv): Promise<Response> {
    // Belt and braces: the dev worker has no routes, but even if it were ever
    // reachable elsewhere it only answers when explicitly flagged as the local UI.
    if (env.DEV_UI !== "1") {
      return new Response("Not found", { status: 404 });
    }
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message }, error.status);
      }
      if (error instanceof ProdAccessError) {
        return jsonResponse({ error: error.message }, 502);
      }
      return jsonResponse({ error: errorMessage(error) }, 500);
    }
  },
} satisfies ExportedHandler<DevEnv>;
