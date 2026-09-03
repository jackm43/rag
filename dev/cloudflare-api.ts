// Read-only access to the production D1 database and AI_CONFIG KV namespace over
// the Cloudflare REST API, for the "load from production" panels. Uses the
// operator's CLOUDFLARE_API_TOKEN (needs D1:Read and Workers KV Storage:Read).
// Only SELECTs are issued from here; production is never written.
import { isRecord } from "../src/lib/contracts";
import type { DevEnv } from "./env";

const API_BASE = "https://api.cloudflare.com/client/v4";
const API_TIMEOUT_MS = 30_000;

export class ProdAccessError extends Error {}

const requireProdAccess = (env: DevEnv) => {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new ProdAccessError(
      "CLOUDFLARE_API_TOKEN is not set for the dev worker. Export it in your shell (or via op run) and restart `pnpm run dev:ui`.",
    );
  }
};

const apiErrors = (payload: unknown) =>
  isRecord(payload) && Array.isArray(payload.errors)
    ? payload.errors
      .map((error) => (isRecord(error) ? `${error.code ?? ""} ${error.message ?? ""}`.trim() : String(error)))
      .join("; ")
    : "";

const cfFetch = async (env: DevEnv, path: string, init: RequestInit = {}): Promise<Response> => {
  requireProdAccess(env);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
  return fetch(`${API_BASE}/accounts/${env.CF_ACCOUNT_ID}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
};

export const d1Select = async <T = Record<string, unknown>>(
  env: DevEnv,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => {
  if (!/^\s*select\b/i.test(sql)) {
    throw new Error("only SELECT statements are allowed against production");
  }
  if (!env.PROD_D1_DATABASE_ID) {
    throw new ProdAccessError("PROD_D1_DATABASE_ID is not configured in wrangler.dev.jsonc");
  }
  const response = await cfFetch(env, `/d1/database/${env.PROD_D1_DATABASE_ID}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload) || payload.success !== true) {
    throw new ProdAccessError(`D1 query failed (${response.status}): ${apiErrors(payload) || "unknown error"}`);
  }
  const first = Array.isArray(payload.result) ? payload.result[0] : null;
  return isRecord(first) && Array.isArray(first.results) ? (first.results as T[]) : [];
};

export const kvText = async (env: DevEnv, key: string): Promise<string | null> => {
  if (!env.PROD_KV_NAMESPACE_ID) {
    throw new ProdAccessError("PROD_KV_NAMESPACE_ID is not configured in wrangler.dev.jsonc");
  }
  const response = await cfFetch(
    env,
    `/storage/kv/namespaces/${env.PROD_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`,
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new ProdAccessError(`KV read failed (${response.status}): ${apiErrors(payload) || "unknown error"}`);
  }
  return response.text();
};

export const kvKeys = async (env: DevEnv): Promise<string[]> => {
  if (!env.PROD_KV_NAMESPACE_ID) {
    throw new ProdAccessError("PROD_KV_NAMESPACE_ID is not configured in wrangler.dev.jsonc");
  }
  const response = await cfFetch(env, `/storage/kv/namespaces/${env.PROD_KV_NAMESPACE_ID}/keys`);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload) || !Array.isArray(payload.result)) {
    throw new ProdAccessError(`KV list failed (${response.status}): ${apiErrors(payload) || "unknown error"}`);
  }
  return payload.result
    .map((entry) => (isRecord(entry) && typeof entry.name === "string" ? entry.name : null))
    .filter((name): name is string => name !== null);
};
