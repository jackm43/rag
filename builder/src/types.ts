export interface Env {
  PROJECTS: DurableObjectNamespace<import("./project").Project>;
  RUNNERS: DurableObjectNamespace<import("./project").BuildContainer>;
  AUTH: DurableObjectNamespace<import("./auth").Auth>;
  ROOMS: DurableObjectNamespace<import("./rooms").Rooms>;
  DIRECTORY: DurableObjectNamespace<import("./directory").Directory>;
  ARTIFACTS: R2Bucket;
  APP_ORIGIN: string;
  ALLOWED_GUILD_IDS: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  CF_AIG_TOKEN: string;
  CODING_MODEL: string;
  CODING_REASONING_EFFORT: string;
}

/** A verified guild member, as shown to generated apps. */
export type Member = { id: string; name: string; avatar: string | null };

/** Who is asking the builder to act, as asserted by the Discord bot. */
export type Scope = {
  guild_id: string;
  channel_id: string;
  user_id: string;
  moderator?: boolean;
};

export type Status =
  | "queued"
  | "building"
  | "publishing"
  | "ready"
  | "failed"
  | "cancelled"
  | "deleted";

export type Job = {
  id: string;
  slug: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  /** requests[0] is the original request; later entries are changes, one per revision. */
  requests: string[];
  revision: number;
  status: Status;
  started: number;
  finished?: number;
  /** The release whose source seeds the current revision. */
  base?: number;
  active?: number;
  releases: number[];
  restarts: number;
  operations: string[];
  title?: string;
  summary?: string;
  error?: string;
};

export const TERMINAL: Status[] = ["ready", "failed", "cancelled", "deleted"];
export const idPattern = /^[a-f0-9]{32}$/;
export const snowflake = /^\d{17,20}$/;

export function allowedGuilds(env: Env) {
  return env.ALLOWED_GUILD_IDS.split(",")
    .map((value) => value.trim())
    .filter((value) => snowflake.test(value));
}

export function allowedGuild(env: Env, guild: string) {
  return allowedGuilds(env).includes(guild);
}

export function validScope(env: Env, scope: Scope) {
  return (
    [scope.guild_id, scope.channel_id, scope.user_id].every(
      (value) => typeof value === "string" && snowflake.test(value),
    ) && allowedGuild(env, scope.guild_id)
  );
}

export const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

export const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Read a body without buffering more than `max` bytes. */
export async function readBytes(body: Request | Response, max: number) {
  const reader = body.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJSON<T = any>(
  body: Request | Response,
  max: number,
): Promise<T> {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      await readBytes(body, max),
    ),
  );
}

export function project(env: Env, id: string) {
  if (!idPattern.test(id)) throw new Error("invalid_id");
  return env.PROJECTS.get(env.PROJECTS.idFromName(id));
}

export function appUrl(env: Env, slug: string) {
  return new URL(`/${slug}/`, env.APP_ORIGIN).href;
}
