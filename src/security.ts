import type { Env } from "./types";

const splitList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export const getGatewayControlToken = (env: Env) =>
  (env.RAGBOT_ADMIN_TOKEN?.trim() || env.DISCORD_BOT_TOKEN).trim();

export const isDiscordGuildAllowed = (env: Env, guildId: string | undefined) => {
  const allowedGuildIds = splitList(env.DISCORD_ALLOWED_GUILD_IDS);
  if (allowedGuildIds.length === 0) {
    return true;
  }
  return guildId !== undefined && allowedGuildIds.includes(guildId);
};
