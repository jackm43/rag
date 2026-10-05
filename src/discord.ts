// Discord REST over Workers fetch: rate limits, bounded retries, and reply formatting.
import type { Env } from "./index.ts";

const API = "https://discord.com/api/v10";
const SUPPRESS_EMBEDS = 1 << 2;

export type Attachment = { name: string; type: string; data: Uint8Array };

// Earliest time (ms) the next request may go out, per route and per credential's global limit.
const routeWaits = new Map<string, number>();
const globalWaits = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function seconds(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function delay(route: string, until: number) {
  if (routeWaits.size > 256) {
    for (const [key, at] of routeWaits) if (at <= Date.now()) routeWaits.delete(key);
  }
  routeWaits.set(route, Math.max(routeWaits.get(route) ?? 0, until));
}

/**
 * Send a Discord request within a 25 s budget and at most four attempts. Rate-limited (429)
 * requests wait for Discord's delay; idempotent methods also retry network errors and 5xx.
 * POST is never replayed after an ambiguous failure, which could duplicate a message.
 */
async function discordFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  const route = `${method} ${url}`;
  const credential = new Headers(init.headers).has("authorization") ? "bot" : "webhook";
  const idempotent = method !== "POST";
  const deadline = Date.now() + 25_000;
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(routeWaits.get(route) ?? 0, globalWaits.get(credential) ?? 0) - Date.now();
    if (Date.now() + Math.max(wait, 0) >= deadline) throw new Error("Discord rate limit exceeds the request budget");
    if (wait > 0) await sleep(wait);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(15_000, deadline - Date.now())) });
    } catch (error) {
      if (!idempotent || attempt === 3) throw error;
      delay(route, Date.now() + 500 * 2 ** attempt);
      continue;
    }
    const resetAfter = seconds(response.headers.get("x-ratelimit-reset-after"));
    if (response.headers.get("x-ratelimit-remaining") === "0" && resetAfter !== null) {
      delay(route, Date.now() + resetAfter * 1000);
    }
    if (response.status === 429) {
      const body: any = await response.clone().json().catch(() => null);
      const retry = seconds(body?.retry_after) ?? seconds(response.headers.get("retry-after"));
      // A limit response without a usable delay must never cause immediate retries.
      if (retry === null || attempt === 3) return response;
      const until = Date.now() + Math.max(retry, 0.05) * 1000;
      delay(route, until);
      if (body?.global === true || response.headers.get("x-ratelimit-global") === "true") {
        globalWaits.set(credential, Math.max(globalWaits.get(credential) ?? 0, until));
      }
      await response.body?.cancel();
      continue;
    }
    if (idempotent && attempt < 3 && [500, 502, 503, 504].includes(response.status)) {
      delay(route, Date.now() + 500 * 2 ** attempt);
      await response.body?.cancel();
      continue;
    }
    return response;
  }
}

function botRequest(env: Env, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  return discordFetch(API + path, { ...init, headers });
}

// Deleted or unknown resources resolve to null.
async function find(env: Env, path: string): Promise<any> {
  const response = await botRequest(env, path);
  return response.ok ? response.json() : null;
}

export const getMessage = (env: Env, channelId: string, messageId: string) =>
  find(env, `/channels/${channelId}/messages/${messageId}`);

/** Gateway URL and the daily IDENTIFY budget (`session_start_limit`). */
export async function gatewayBot(env: Env): Promise<any> {
  const response = await botRequest(env, "/gateway/bot");
  if (!response.ok) throw new Error(`Discord API request failed (${response.status})`);
  return response.json();
}

export async function username(env: Env, userId: string): Promise<string | null> {
  try {
    return (await find(env, `/users/${userId}`))?.username ?? null;
  } catch {
    return null;
  }
}

const roleCache = new Map<string, { roles: string[]; expires: number }>();

export async function botRoles(env: Env, guildId: string, botUserId: string): Promise<string[]> {
  const key = `${guildId}:${botUserId}`;
  const cached = roleCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.roles;
  try {
    const member = await find(env, `/guilds/${guildId}/members/${botUserId}`);
    if (member) {
      roleCache.set(key, { roles: member.roles, expires: Date.now() + 300_000 });
      return member.roles;
    }
  } catch {
    // Keep the last known roles.
  }
  return cached?.roles ?? [];
}

/** Reply in a channel without pinging anyone or unfurling links; the text is sent as given. */
export function postMessage(env: Env, channelId: string, content: string, replyTo: string) {
  return botRequest(env, `/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [], replied_user: false },
      flags: SUPPRESS_EMBEDS,
      message_reference: { message_id: replyTo, fail_if_not_exists: false },
    }),
  });
}

/**
 * Edit the deferred interaction reply, or post a follow-up. The interaction token in the URL
 * authenticates this route, so the bot credential is never sent here.
 */
export async function reply(
  interaction: any,
  content: string,
  { users, files = [], followup = false }: { users?: string[]; files?: Attachment[]; followup?: boolean } = {},
) {
  const payload = { content: truncate(content, 2000), allowed_mentions: { parse: [], users } };
  let init: RequestInit = { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  if (files.length) {
    const form = new FormData();
    const attachments = files.map((file, id) => ({ id: String(id), filename: file.name }));
    form.append("payload_json", JSON.stringify({ ...payload, attachments }));
    files.forEach((file, i) => form.append(`files[${i}]`, new Blob([file.data], { type: file.type }), file.name));
    init = { body: form };
  }
  const url = `${API}/webhooks/${interaction.application_id}/${interaction.token}`;
  const response = await discordFetch(followup ? url : `${url}/messages/@original`, {
    ...init,
    method: followup ? "POST" : "PATCH",
  });
  if (!response.ok) {
    const error: any = await response.json().catch(() => null);
    console.warn(`interaction_write_rejected status=${response.status} code=${error?.code ?? null}`);
  }
  return response.ok;
}

export const guildAllowed = (env: Env, guildId: string | undefined) =>
  env.ALLOWED_GUILD_IDS.split(",").some((id) => id.trim() === guildId);

export const displayName = (user: any, nick?: string | null): string =>
  [nick, user.global_name, user.username].find((name) => name?.trim())?.trim() ?? "user";

// Discord limits count UTF-16 code units; never split a surrogate pair.
export function truncate(text: string, limit: number) {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  return text.slice(0, code >= 0xd800 && code < 0xdc00 ? limit - 1 : limit);
}
