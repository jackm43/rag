// Discord REST over Workers fetch: route and global rate limits and bounded retries.
export const API = "https://discord.com/api/v10";

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
export async function discordFetch(url: string, init: RequestInit = {}): Promise<Response> {
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

// Names follow Oceanic's Constants (MIT, OceanicJS/Oceanic).
export const MessageFlags = { SUPPRESS_EMBEDS: 1 << 2 } as const;

export function botRequest(token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${token}`);
  return discordFetch(API + path, { ...init, headers });
}

/** Gateway URL and the daily IDENTIFY budget (`session_start_limit`). */
export async function getGatewayBot(token: string): Promise<any> {
  const response = await botRequest(token, "/gateway/bot");
  if (!response.ok) throw new Error(`Discord API request failed (${response.status})`);
  return response.json();
}

// Discord limits count UTF-16 code units; never split a surrogate pair.
export function truncate(text: string, limit: number) {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  return text.slice(0, code >= 0xd800 && code < 0xdc00 ? limit - 1 : limit);
}
