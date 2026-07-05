import { errorMessage, logger } from "@rag/logger";
import type { Env } from "../../contracts";

type RagBanRow = {
  expires_at: string;
};

// raghammer bans gate /rag and every AI ingress (slash commands and gateway
// mentions/thread replies). One query, shared by all of them.
export const activeRagBanForUser = async (env: Env, userId: string, now: Date) =>
  env.DB.prepare(
    "SELECT expires_at FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
  )
    .bind(userId, now.toISOString())
    .first<RagBanRow>();

// AI-path variant of the lookup: fails open on D1 errors, matching the
// usage guard's availability-first stance (/rag keeps its throwing lookup
// because its whole flow already runs inside the deferred error handler).
export const activeAiBanForUser = async (env: Env, userId: string, now: Date) => {
  try {
    return await activeRagBanForUser(env, userId, now);
  } catch (error) {
    logger.warn("ai_ban_check_failed", { error: errorMessage(error) });
    return null;
  }
};

export const formatBanExpiry = (expiresAt: string) => {
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) {
    return expiresAt;
  }
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
};

export const aiBanMessage = (expiresAt: string) =>
  `You cannot use AI commands until ${formatBanExpiry(expiresAt)}.`;
