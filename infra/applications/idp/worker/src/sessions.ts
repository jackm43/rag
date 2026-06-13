import { logger, type Identity, type SessionTier } from "@platy/sdk";
import { audit, secretHash, secretHashMatches } from "./registry";
import type { Env } from "./types";

export const REFRESH_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

const REFRESH_PREFIX = "rst_";
const SESSION_ID_LENGTH = 36;

export type Session = {
  id: string;
  subject: string;
  email: string | null;
  jkt: string;
  tier: SessionTier;
  refreshExpiresAt: number;
};

type SessionRow = {
  id: string;
  subject: string;
  email: string | null;
  jkt: string;
  tier: string;
  refresh_hash: string;
  refresh_expires_at: number;
  revoked: number;
};

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const newRefreshSecret = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

const refreshToken = (id: string, secret: string): string => `${REFRESH_PREFIX}${id}_${secret}`;

const parseRefreshToken = (token: string): { id: string; secret: string } | null => {
  if (!token.startsWith(REFRESH_PREFIX)) {
    return null;
  }
  const body = token.slice(REFRESH_PREFIX.length);
  if (body.length <= SESSION_ID_LENGTH + 1 || body[SESSION_ID_LENGTH] !== "_") {
    return null;
  }
  return { id: body.slice(0, SESSION_ID_LENGTH), secret: body.slice(SESSION_ID_LENGTH + 1) };
};

export const createSession = async (
  env: Env,
  identity: Identity,
  jkt: string,
  tier: SessionTier,
): Promise<{ session: Session; refreshToken: string }> => {
  const id = crypto.randomUUID();
  const secret = newRefreshSecret();
  const refreshExpiresAt = Math.floor(Date.now() / 1000) + REFRESH_LIFETIME_SECONDS;
  await env.DB.prepare(
    "INSERT INTO idp_sessions (id, subject, email, jkt, tier, refresh_hash, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, identity.subject, identity.email, jkt, tier, await secretHash(secret), refreshExpiresAt)
    .run();
  return {
    session: { id, subject: identity.subject, email: identity.email, jkt, tier, refreshExpiresAt },
    refreshToken: refreshToken(id, secret),
  };
};

export const consumeRefreshToken = async (
  env: Env,
  token: string,
  jkt: string,
): Promise<{ session: Session; refreshToken: string } | null> => {
  const parsed = parseRefreshToken(token);
  if (!parsed) {
    return null;
  }
  const row = await env.DB.prepare("SELECT * FROM idp_sessions WHERE id = ?")
    .bind(parsed.id)
    .first<SessionRow>();
  if (!row || row.revoked !== 0) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (now >= row.refresh_expires_at) {
    return null;
  }
  if (row.jkt !== jkt) {
    logger.warn("session_key_mismatch", { session: row.id });
    return null;
  }
  if (!(await secretHashMatches(parsed.secret, row.refresh_hash))) {
    await env.DB.prepare("UPDATE idp_sessions SET revoked = 1 WHERE id = ?").bind(row.id).run();
    await audit(env, row.email ?? row.subject, "session_refresh_reuse_detected", row.id);
    logger.warn("session_refresh_reuse_detected", { session: row.id });
    return null;
  }

  const secret = newRefreshSecret();
  await env.DB.prepare("UPDATE idp_sessions SET refresh_hash = ?, last_refresh_at = unixepoch() WHERE id = ?")
    .bind(await secretHash(secret), row.id)
    .run();
  return {
    session: {
      id: row.id,
      subject: row.subject,
      email: row.email,
      jkt: row.jkt,
      tier: row.tier === "community" ? "community" : "internal",
      refreshExpiresAt: row.refresh_expires_at,
    },
    refreshToken: refreshToken(row.id, secret),
  };
};

export const revokeSession = async (env: Env, token: string): Promise<boolean> => {
  const parsed = parseRefreshToken(token);
  if (!parsed) {
    return false;
  }
  const row = await env.DB.prepare("SELECT * FROM idp_sessions WHERE id = ?")
    .bind(parsed.id)
    .first<SessionRow>();
  if (!row || !(await secretHashMatches(parsed.secret, row.refresh_hash))) {
    return false;
  }
  const result = await env.DB.prepare(
    "UPDATE idp_sessions SET revoked = 1 WHERE id = ? AND revoked = 0",
  )
    .bind(row.id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
};
