import { env } from "cloudflare:test";
import nacl from "tweetnacl";
import type { Env } from "../src/env";

export const baseEnv = (overrides: Record<string, unknown> = {}): Env => ({
  DB: env.DB, AI_CONFIG: undefined, DISCORD_APPLICATION_ID: "application-id",
  DISCORD_BOT_TOKEN: "bot-token", CF_AIG_TOKEN: "gateway-token",
  CF_ACCOUNT_ID: "account-id", CF_AIG_GATEWAY_ID: "platy", ...overrides,
}) as unknown as Env;

export const clearTables = (...tables: string[]) =>
  env.DB.batch(tables.map(table => env.DB.prepare(`DELETE FROM ${table}`)));

export const insertBan = (userId: string, expiresAt: string) => env.DB.prepare(
  "INSERT INTO rag_command_bans (banned_user_id, banned_by_user_id, expires_at) VALUES (?, ?, ?)",
).bind(userId, "moderator", expiresAt).run();

export type Call = { url: string; init?: RequestInit };
// Restore fetch even when the operation or its assertions fail.
export const withFetch = async <T>(
  route: (call: Call) => Response | undefined,
  body: (calls: Call[]) => Promise<T>,
): Promise<T> => {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return route(call) ?? Response.json({});
  };
  try { return await body(calls); }
  finally { globalThis.fetch = originalFetch; }
};

export const signingFixture = () => {
  const pair = nacl.sign.keyPair();
  return { secretKey: pair.secretKey, publicKeyHex: Buffer.from(pair.publicKey).toString("hex") };
};
export const signedRequest = (
  payload: unknown, secretKey: Uint8Array,
  timestamp = String(Math.floor(Date.now() / 1000)),
) => {
  const rawBody = JSON.stringify(payload);
  const signature = nacl.sign.detached(new TextEncoder().encode(timestamp + rawBody), secretKey);
  const request = new Request("https://example.com/interactions", {
    method: "POST", body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": Buffer.from(signature).toString("hex"),
      "x-signature-timestamp": timestamp,
    },
  });
  return { request, rawBody };
};

export const query = (sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...values);
