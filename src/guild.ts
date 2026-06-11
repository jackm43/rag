import { logger } from "./logger";
import type { Env } from "./types";

export const parseAllowedGuildIds = (raw: string | undefined): Set<string> | null => {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const ids = trimmed
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return null;
  }
  return new Set(ids);
};

export const isGuildAllowed = (env: Env, guildId: string | null | undefined): boolean => {
  const allowed = parseAllowedGuildIds(env.ALLOWED_GUILD_IDS);
  if (!allowed) {
    return true;
  }
  if (!guildId) {
    return false;
  }
  return allowed.has(guildId);
};

export const rejectDisallowedGuild = (env: Env, guildId: string | null | undefined): boolean => {
  if (isGuildAllowed(env, guildId)) {
    return false;
  }
  logger.info("guild_rejected", { guildId: guildId ?? null });
  return true;
};
