// The local debugging UI worker. Local only (wrangler.dev.jsonc, `pnpm run
// dev:ui`): serves the single-page UI and a small JSON API that feeds synthetic
// Discord events into the real bot code (see ./harness.ts).
import { commands } from "../src/commands";
import { isRecord } from "../src/lib/contracts";
import { jsonResponse } from "../src/lib/http";
import { errorMessage } from "../src/lib/logger";
import type { DevEnv } from "./env";
import {
  resolveDevConfig,
  simulateInteraction,
  simulateMention,
  type ConfigOverrides,
  type InteractionSimulationInput,
  type MentionSimulationInput,
} from "./harness";
import appJs from "./ui/app.client.js";
import appCss from "./ui/app.css";
import indexHtml from "./ui/index.html";

const text = (body: string, contentType: string) =>
  new Response(body, { headers: { "content-type": contentType, "cache-control": "no-store" } });

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
  guildId: defaultGuildId(env),
  hasAigToken: Boolean(env.CF_AIG_TOKEN),
  config: await resolveDevConfig({}),
  commands: [...commands.values()].map((command) => ({
    ...command.data.toJSON(),
    adminOnly: Boolean(command.adminOnly),
    aiLimited: Boolean(command.aiLimited),
  })),
});

const resetLocalLimits = async (env: DevEnv) => {
  const result = await env.DB.prepare("DELETE FROM rag_ai_requests").run();
  return { deleted: result.meta.changes ?? 0 };
};

const assets: Record<string, [string, string]> = {
  "/": [indexHtml, "text/html"],
  "/app.css": [appCss, "text/css"],
  "/app.client.js": [appJs, "text/javascript"],
};

const route = async (request: Request, env: DevEnv): Promise<Response> => {
  const url = new URL(request.url);
  const asset = assets[url.pathname];
  if (request.method === "GET" && asset) return text(asset[0], `${asset[1]}; charset=utf-8`);
  const routes: Record<string, () => Promise<unknown>> = {
    "GET /api/meta": () => meta(env),
    "POST /api/config": async () => resolveDevConfig(overridesFrom((await readJson(request)).overrides)),
    "POST /api/mention": async () => simulateMention(env, mentionInputFrom(env, await readJson(request))),
    "POST /api/interaction": async () => simulateInteraction(env, interactionInputFrom(env, await readJson(request))),
    "POST /api/local/reset-limits": () => resetLocalLimits(env),
  };
  const key = `${request.method} ${url.pathname}`;
  if (key === "POST /api/mention" && !env.CF_AIG_TOKEN) {
    throw new HttpError(503, "CF_AIG_TOKEN is not set for the dev worker; restart via `pnpm run dev:ui`.");
  }
  const handler = routes[key];
  return handler ? jsonResponse(await handler()) : new Response("Not found", { status: 404 });
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
      return jsonResponse({ error: errorMessage(error) }, 500);
    }
  },
} satisfies ExportedHandler<DevEnv>;
