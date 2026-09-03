import { isSnowflake } from "../contracts";
import { logger } from "../logger";
import type { Env } from "../../env";

// Guild allowlist shared by every ingress: the interactions webhook and the
// gateway Durable Object's MESSAGE_CREATE path.
//
// Semantics: when ALLOWED_GUILD_IDS is set, the gate FAILS CLOSED — only the
// listed guilds pass, and messages without a guild id (DMs) are denied.
// Entries that are not snowflakes are dropped, so a misconfigured value
// denies everything rather than allowing everything. When the var is unset
// (or blank), the gate allows but warns once per isolate so existing deploys
// keep working until the var is configured.

const parseAllowedGuildIds = (value: string | undefined): Set<string> | null => {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  return new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter((id) => isSnowflake(id)),
  );
};

let warnedAllowlistUnset = false;
// The var is fixed for an isolate's lifetime; parse it once per distinct value
// instead of on every interaction and gateway message.
const UNPARSED = Symbol("unparsed");
let parsedFor: string | undefined | typeof UNPARSED = UNPARSED;
let parsedAllowlist: Set<string> | null = null;

export const isGuildAllowed = (env: Env, guildId: string | undefined): boolean => {
  if (parsedFor !== env.ALLOWED_GUILD_IDS) {
    parsedFor = env.ALLOWED_GUILD_IDS;
    parsedAllowlist = parseAllowedGuildIds(env.ALLOWED_GUILD_IDS);
  }
  const allowedGuildIds = parsedAllowlist;
  if (allowedGuildIds === null) {
    if (!warnedAllowlistUnset) {
      warnedAllowlistUnset = true;
      logger.warn("allowed_guild_ids_unset", {
        hint: "set ALLOWED_GUILD_IDS to enforce the guild allowlist",
      });
    }
    return true;
  }

  return guildId !== undefined && allowedGuildIds.has(guildId);
};

export const GUILD_NOT_ALLOWED_MESSAGE = "This bot only works in its home server.";
