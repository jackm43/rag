// Local-only dev UI: serves dev/ui and runs the real bot handlers against stubbed Discord.
import { AsyncLocalStorage } from "node:async_hooks";
import { SETTINGS_SQL } from "../src/ai.ts";
import { handleMessage } from "../src/chat.ts";
import { ADMIN_IDS, commands, dispatch, MODS_ROLE_ID } from "../src/commands.ts";
import type { Env } from "../src/index.ts";
import { catalogOverrides, draftOverrides, draftRow, HttpError, isObject, loadCatalog, resolveConfig, SettingsEditor, sha256 } from "./settings.ts";

export interface DevEnv extends Env {
  DEV_UI: string;
  CF_ACCOUNT_ID: string;
  D1_DATABASE_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  ASSETS: Fetcher;
}

type Simulation = {
  input: any;
  ai: any[];
  calls: any[];
  logs: { level: string; message: string }[];
  edits: any[];
  followUps: any[];
  messages: any[];
  history: any[];
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.DEV_UI !== "1") return new Response(null, { status: 404 });
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return new Response(null, { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      return request.method === "GET" ? env.ASSETS.fetch(request) : new Response(null, { status: 404 });
    }
    try {
      return Response.json(await api(request, env, url), { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      console.error(error);
      return Response.json({ error: "Request failed. Check the local worker logs." }, { status: 500 });
    }
  },
} satisfies ExportedHandler<DevEnv>;

async function api(request: Request, env: DevEnv, url: URL): Promise<unknown> {
  const path = url.pathname.slice("/api/".length);
  if (request.method === "GET") {
    if (path === "revision") return { revision: await assetRevision(env, url) };
    if (path === "meta") return meta(env, url);
    throw new HttpError("Not found.", 404);
  }
  // Only same-origin JSON requests from the UI may save settings or call models.
  if (
    request.method !== "POST" ||
    request.headers.get("origin") !== url.origin ||
    request.headers.get("x-ragbot-ui") !== "1" ||
    request.headers.get("content-type")?.split(";")[0] !== "application/json"
  ) {
    throw new HttpError("Forbidden.", 403);
  }
  const body: any = await request.json().catch(() => null);
  if (!isObject(body)) throw new HttpError("Invalid simulation input.");
  const editor = new SettingsEditor(env, body.target ?? "local");
  switch (path) {
    case "history":
      return editor.history(body);
    case "settings/load":
      return editor.read();
    case "settings/review":
      return editor.preview(body);
    case "settings/save":
      return editor.save(body);
  }
  const baseline = await editor.read();
  if (body.baseRevision && body.baseRevision !== baseline.revision) {
    throw new HttpError("Settings changed since you loaded them. Reload before testing.", 409);
  }
  if (path === "models") return loadCatalog(env, baseline.config, Boolean(body.refresh));
  const overrides = draftOverrides(body.overrides);
  const image = body.command === "bicture" || body.page === "bicture";
  if (image || path === "mention") Object.assign(overrides, await catalogOverrides(env, overrides, baseline.resources, image));
  if (path === "config") return resolveConfig(overrides, baseline.resources);
  if (path !== "mention" && path !== "interaction") throw new HttpError("Not found.", 404);
  const filled = (value: unknown) => typeof value === "string" && value.trim() !== "";
  const required = [body.identity?.userId, body.identity?.username, body.channelId, path === "mention" ? body.content : body.command];
  if (!required.every(filled)) throw new HttpError("Invalid simulation input.");
  return simulate(env, path, {
    ...body,
    guildId: body.guildId || env.ALLOWED_GUILD_IDS.split(",")[0].trim(),
    botUserId: body.botUserId || env.DISCORD_APPLICATION_ID,
    settings: await draftRow(overrides, baseline.resources, baseline.revision),
  });
}

async function meta(env: DevEnv, url: URL) {
  const live = await new SettingsEditor(env, "live").read();
  return {
    revision: await assetRevision(env, url),
    defaults: { userId: [...ADMIN_IDS].sort()[0], username: "dev_user", globalName: "Dev User", channelId: "123456789012345678" },
    applicationId: env.DISCORD_APPLICATION_ID,
    guildId: env.ALLOWED_GUILD_IDS.split(",")[0].trim(),
    config: live.config,
    commands: Object.entries(commands).map(([name, command]) => ({
      name,
      description: command.description,
      options: command.options,
      adminOnly: Boolean(command.admin),
      requiredRoleId: command.role ?? null,
    })),
  };
}

// The UI reloads itself when its files change.
async function assetRevision(env: DevEnv, url: URL) {
  const files = ["/", "/app.css", "/app.client.js"].map(async (path) => (await env.ASSETS.fetch(new URL(path, url))).text());
  return sha256(await Promise.all(files));
}

// Each simulation records its own requests and logs, even when several run at once.
const simulations = new AsyncLocalStorage<Simulation>();
const upstream = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const run = simulations.getStore();
  if (!run) return upstream(input, init);
  const url = new URL(input instanceof Request ? input.url : input);
  const started = Date.now();
  const call: any = {
    method: init.method ?? "GET",
    // Interaction webhook URLs contain the interaction token.
    url: url.href.replace(/(discord\.com\/api\/v10\/webhooks\/\d+\/)[^/]+/, "$1[redacted]"),
    headers: Object.fromEntries(
      [...new Headers(init.headers)].map(([name, value]) => [name, /authorization|token|cookie|key/i.test(name) ? "[redacted]" : value]),
    ),
    body: describeBody(init.body),
  };
  run.calls.push(call);
  // Only Discord is stubbed; provider media downloads use the network.
  const response = url.hostname === "discord.com" ? await discord(run, url, init) : await upstream(input, init);
  if (url.hostname === "discord.com") call.response = { status: response.status, body: await response.clone().json() };
  call.durationMs = Date.now() - started;
  return response;
};

for (const level of ["log", "warn", "error"] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    simulations.getStore()?.logs.push({ level, message: args.join(" ") });
    write(...args);
  };
}

function describeBody(body: unknown) {
  if (body == null) return null;
  if (typeof body !== "string") return { multipart: true };
  try {
    return JSON.parse(body);
  } catch {
    return "[unparsed]";
  }
}

async function discord(run: Simulation, url: URL, init: RequestInit) {
  const [resource, id, ...rest] = url.pathname.replace(/^\/api\/v10\//, "").split("/");
  const method = init.method ?? "GET";
  if (resource === "channels" && method === "POST" && rest.at(-1) === "messages") {
    const message = await captureWrite(init.body, id);
    run.messages.push(message);
    return Response.json({ id: message.id });
  }
  if (resource === "channels" && method === "GET" && rest.length === 2) {
    return Response.json(run.history.find((message) => message.id === rest[1]) ?? null);
  }
  if (resource === "webhooks" && (method === "PATCH" || method === "POST")) {
    (method === "PATCH" ? run.edits : run.followUps).push(await captureWrite(init.body, run.input.channelId));
    return Response.json({ id: snowflake() });
  }
  if (resource === "users") {
    const identity = run.input.resolvedUsers?.[id];
    return Response.json(identity ? author(identity) : { id, username: `user_${id.slice(-4)}` });
  }
  if (resource === "guilds") return Response.json({ roles: [] });
  return Response.json({});
}

async function captureWrite(body: unknown, channelId: string) {
  const form = body instanceof FormData ? body : null;
  const data = JSON.parse(String(form ? form.get("payload_json") : body));
  const attachments = await Promise.all(
    (data.attachments ?? []).map(async ({ filename }: any, index: number) => {
      const file = form!.get(`files[${index}]`) as File;
      const preview = file.size <= 8 << 20 ? `data:${file.type};base64,${base64(new Uint8Array(await file.arrayBuffer()))}` : undefined;
      return { name: filename, contentType: file.type, bytes: file.size, dataUrl: preview };
    }),
  );
  return { id: snowflake(), channelId, content: data.content ?? "", allowedMentions: data.allowed_mentions, attachments };
}

async function simulate(env: DevEnv, mode: "mention" | "interaction", input: any) {
  const run: Simulation = { input, ai: [], calls: [], logs: [], edits: [], followUps: [], messages: [], history: [] };
  // Model calls are real; the draft settings replace the saved row and Discord is stubbed.
  const botEnv: DevEnv = { ...env, AI: tapModels(env.AI, run.ai), DB: withSettings(env.DB, input.settings) };
  const started = Date.now();
  return simulations.run(run, async () => {
    const output = mode === "mention" ? await mention(botEnv, run, input) : await interaction(botEnv, run, input);
    return { ...output, durationMs: Date.now() - started, ai: run.ai, calls: run.calls, logs: run.logs };
  });
}

async function mention(env: DevEnv, run: Simulation, input: any) {
  const transcript: any[] = input.transcript ?? [];
  const asMessage = (entry: any) => {
    const identity = entry.author ?? input.identity;
    return {
      id: entry.id,
      channel_id: input.channelId,
      guild_id: input.guildId,
      content: entry.content,
      author: entry.role === "bot" ? { id: input.botUserId, username: "ragbot", bot: true } : author(identity),
      member: { nick: identity.nick },
    };
  };
  run.history = transcript.map(asMessage);
  const pinged = input.mentionBot ?? true;
  const message: any = {
    id: snowflake(),
    guild_id: input.guildId,
    channel_id: input.channelId,
    content: pinged ? `<@${input.botUserId}> ${input.content}` : input.content,
    author: author(input.identity),
    member: { nick: input.identity.nick },
    mentions: pinged ? [{ id: input.botUserId, username: "ragbot" }] : [],
    mention_roles: [],
    attachments: [],
  };
  const replied = transcript.find((entry) => entry.id === input.replyToId);
  if (replied) {
    message.message_reference = { channel_id: input.channelId, message_id: replied.id };
    message.referenced_message = asMessage(replied);
  }
  await handleMessage(env, message, input.botUserId);
  const record = await env.DB.prepare("SELECT * FROM rag_ai_interactions WHERE message_id = ? ORDER BY id DESC LIMIT 1")
    .bind(message.id)
    .first();
  return { message, replies: run.messages, db: { interaction: record } };
}

async function interaction(env: DevEnv, run: Simulation, input: any) {
  const options: any[] = input.options ?? [];
  const users = Object.fromEntries(
    options
      .filter((option) => option.type === 6 && option.value)
      .map((option) => [option.value, author(input.resolvedUsers?.[option.value] ?? { userId: option.value, username: `user_${option.value.slice(-4)}` })]),
  );
  const payload = {
    id: snowflake(),
    type: 2,
    version: 1,
    application_id: env.DISCORD_APPLICATION_ID,
    token: `dev-interaction-${snowflake()}`,
    guild_id: input.guildId,
    channel_id: input.channelId,
    member: { user: author(input.identity), nick: input.identity.nick, roles: input.modsRole === false ? [] : [MODS_ROLE_ID] },
    data: { id: snowflake(), type: 1, name: input.command, options, resolved: { users } },
  };
  await dispatch(env, payload);
  const record = await env.DB.prepare("SELECT * FROM rag_ai_interactions ORDER BY id DESC LIMIT 1").first();
  return { interaction: payload, edits: run.edits, followUps: run.followUps, channelMessages: run.messages, db: { interaction: record } };
}

// Record each model exchange, tagged `ragbot_env: dev` within AI Gateway's five metadata entries.
function tapModels(ai: Ai, exchanges: any[]) {
  const run = async (model: string, inputs: any, options?: any) => {
    const metadata = options?.gateway?.metadata;
    if (metadata) {
      const tagged = { ragbot_env: "dev", ...metadata };
      for (const key of ["discord_message_id", "discord_channel_id"]) if (Object.keys(tagged).length > 5) delete tagged[key];
      options.gateway.metadata = tagged;
    }
    const exchange: any = { model, settingsRevision: metadata?.ragbot_settings_revision ?? null, request: { model, input: inputs, options } };
    exchanges.push(exchange);
    const started = Date.now();
    try {
      const result = await (options ? ai.run(model, inputs, options) : ai.run(model, inputs));
      exchange.response =
        result instanceof ReadableStream
          ? { stream: true }
          : result instanceof ArrayBuffer || ArrayBuffer.isView(result)
            ? { binary: true, bytes: result.byteLength }
            : result;
      return result;
    } catch (error) {
      exchange.error = error instanceof Error ? error.name : "Error";
      throw error;
    } finally {
      exchange.durationMs = Date.now() - started;
    }
  };
  return { run } as unknown as Ai;
}

// Simulations read the draft settings; every other query goes to the local database.
function withSettings(db: D1Database, settings: { revision: string; document: string }) {
  const prepare = (sql: string) => (sql === SETTINGS_SQL ? { first: async () => settings } : db.prepare(sql));
  return { prepare, batch: (statements: D1PreparedStatement[]) => db.batch(statements) } as unknown as D1Database;
}

const author = (identity: any) => ({ id: identity.userId, username: identity.username, global_name: identity.globalName });

const snowflake = () => String(((BigInt(Date.now()) - 1420070400000n) << 22n) | BigInt(Math.floor(Math.random() * 4096)));

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
