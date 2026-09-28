export interface Env {
  PROJECTS: DurableObjectNamespace;
  RUNNERS: DurableObjectNamespace<import("./project").BuildContainer>;
  AUTH: DurableObjectNamespace;
  ROOMS: DurableObjectNamespace;
  ARTIFACTS: R2Bucket;
  APP_DOMAIN: string;
  AUTH_ORIGIN: string;
  ALLOWED_GUILD_IDS: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  OPENAI_API_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_REPOSITORY: string;
  GITHUB_BASE_BRANCH: string;
}
export type Scope = {
  guild_id: string;
  channel_id: string;
  user_id: string;
  moderator?: boolean;
};
export type Submission = Scope & {
  id: string;
  source_id: string;
  kind: "site" | "feature";
  prompt: string;
  model: string;
  instructions: string;
  config_revision: string;
};
export type Job = Submission & {
  revision: number;
  status:
    | "submitted"
    | "building"
    | "testing"
    | "publishing"
    | "ready"
    | "pr_ready"
    | "failed"
    | "cancelled"
    | "deleted";
  started: number;
  terminal_at?: number;
  runner_cleaned?: boolean;
  seed_revision?: number;
  active?: number;
  releases: number[];
  error?: string;
  url?: string;
  base_sha?: string;
  operation?: string;
  pr_number?: number;
};
export type Artifact = {
  files: Record<string, string>;
  source: Record<string, string>;
  changes?: Record<string, string | null>;
  tests: string[];
};
export const idPattern = /^[a-f0-9]{32}$/;
export const snowflake = /^\d{17,20}$/;
export function validScope(s: Scope, env: Env) {
  return (
    [s.guild_id, s.channel_id, s.user_id].every(
      (v) => typeof v === "string" && snowflake.test(v),
    ) &&
    env.ALLOWED_GUILD_IDS.split(",")
      .map((s) => s.trim())
      .includes(s.guild_id)
  );
}
export function allowed(job: Job, s: Scope) {
  return job.guild_id === s.guild_id && job.channel_id === s.channel_id;
}
export function canManage(job: Job, s: Scope) {
  return allowed(job, s) && (job.user_id === s.user_id || s.moderator === true);
}
export const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
export const token = () =>
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");
export async function hash(s: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export async function boundedJSON(
  request: Request | Response,
  max = 6 * 1024 * 1024,
): Promise<any> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty_body");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
}
export function project(env: Env, id: string) {
  if (!idPattern.test(id)) throw new Error("invalid_id");
  return env.PROJECTS.get(env.PROJECTS.idFromName(id));
}
