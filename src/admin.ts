import { verifyOidcToken, type AccessIdentity } from "./access";
import { CONFIG_DEFAULTS, deleteSetting, getSettings, isConfigKey, setSetting } from "./config";
import { forwardToGateway } from "./gateway";
import { jsonResponse } from "./http";
import { errorMessage, logger } from "./logger";
import type { Env } from "./types";

const authenticate = async (request: Request, env: Env): Promise<AccessIdentity | null> => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return verifyOidcToken(authorization.slice("Bearer ".length), env);
};

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="ragbot-admin"',
    },
  });

const readJsonBody = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

const handleConfigList = async (env: Env) => {
  const settings = await getSettings(env);
  const config = Object.fromEntries(
    Object.entries(CONFIG_DEFAULTS).map(([key, fallback]) => [
      key,
      {
        value: settings[key] ?? fallback,
        default: fallback,
        overridden: key in settings,
      },
    ]),
  );
  return jsonResponse({ config });
};

const handleConfigSet = async (request: Request, env: Env, identity: AccessIdentity) => {
  const body = await readJsonBody<{ key?: string; value?: string }>(request);
  const key = body?.key;
  const value = body?.value;
  if (!key || !isConfigKey(key) || typeof value !== "string") {
    return jsonResponse({ error: "expected body {key, value} with a known config key" }, 400);
  }
  await setSetting(env, key, value);
  logger.info("config_updated", { key, actor: identity.email ?? identity.sub });
  return jsonResponse({ ok: true, key, value });
};

const handleConfigDelete = async (env: Env, key: string, identity: AccessIdentity) => {
  if (!isConfigKey(key)) {
    return jsonResponse({ error: "unknown config key" }, 400);
  }
  await deleteSetting(env, key);
  logger.info("config_reset", { key, actor: identity.email ?? identity.sub });
  return jsonResponse({ ok: true, key, value: CONFIG_DEFAULTS[key] });
};

const handleDbQuery = async (request: Request, env: Env, identity: AccessIdentity) => {
  const body = await readJsonBody<{ sql?: string; params?: unknown[] }>(request);
  const sql = body?.sql?.trim();
  if (!sql) {
    return jsonResponse({ error: "expected body {sql, params?}" }, 400);
  }

  logger.info("admin_db_query", { actor: identity.email ?? identity.sub });
  try {
    const statement = env.DB.prepare(sql);
    const bound = body?.params?.length ? statement.bind(...body.params) : statement;
    const result = await bound.all();
    return jsonResponse({
      results: result.results ?? [],
      meta: result.meta ?? null,
    });
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400);
  }
};

const handleInteractionsList = async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;
  const result = await env.DB.prepare(
    "SELECT id, kind, channel_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, created_at FROM rag_ai_interactions ORDER BY id DESC LIMIT ?",
  )
    .bind(limit)
    .run();
  return jsonResponse({ interactions: result.results ?? [] });
};

export const handleAdminRequest = async (request: Request, env: Env): Promise<Response> => {
  const identity = await authenticate(request, env);
  if (!identity) {
    return unauthorized();
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/admin/whoami" && method === "GET") {
    return jsonResponse({ identity });
  }
  if (path === "/admin/config" && method === "GET") {
    return handleConfigList(env);
  }
  if (path === "/admin/config" && method === "PUT") {
    return handleConfigSet(request, env, identity);
  }
  const configKeyMatch = path.match(/^\/admin\/config\/([a-z0-9_]+)$/);
  if (configKeyMatch && method === "DELETE") {
    return handleConfigDelete(env, configKeyMatch[1], identity);
  }
  if (path === "/admin/db" && method === "POST") {
    return handleDbQuery(request, env, identity);
  }
  if (path === "/admin/interactions" && method === "GET") {
    return handleInteractionsList(request, env);
  }
  if (path === "/admin/gateway/health" && method === "GET") {
    return forwardToGateway(request, env, "/gateway/health");
  }
  if (path === "/admin/gateway/start" && method === "POST") {
    logger.info("gateway_start_requested", { actor: identity.email ?? identity.sub });
    return forwardToGateway(request, env, "/gateway/start");
  }

  return jsonResponse({ error: "not found" }, 404);
};
