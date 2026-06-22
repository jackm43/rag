import { DISCORD_API_BASE_URL, type DiscordMessage, type Env } from "./types";
import { isDiscordMessage, isRecord } from "./validation";

const botHeaders = (env: Env) => ({
  authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
});

export type InteractionMessageData = {
  content: string;
  allowed_mentions?: {
    parse?: string[];
    users?: string[];
  };
};

export const postChannelMessage = async (env: Env, channelId: string, content: string) =>
  fetch(`${DISCORD_API_BASE_URL}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      ...botHeaders(env),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content,
      allowed_mentions: {
        parse: [],
      },
    }),
  });

export const fetchChannelMessages = async (
  env: Env,
  channelId: string,
  options: { before?: string; limit?: number } = {},
): Promise<DiscordMessage[]> => {
  const params = new URLSearchParams();
  if (options.before) {
    params.set("before", options.before);
  }
  params.set("limit", String(options.limit ?? 12));

  const response = await fetch(
    `${DISCORD_API_BASE_URL}/channels/${channelId}/messages?${params}`,
    { headers: botHeaders(env) },
  );
  if (!response.ok) {
    return [];
  }
  const payload = await response.json().catch(() => null);
  return Array.isArray(payload) ? payload.filter(isDiscordMessage) : [];
};

export const fetchMessage = async (
  env: Env,
  channelId: string,
  messageId: string,
): Promise<DiscordMessage | null> => {
  const response = await fetch(
    `${DISCORD_API_BASE_URL}/channels/${channelId}/messages/${messageId}`,
    { headers: botHeaders(env) },
  );
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  return isDiscordMessage(payload) ? payload : null;
};

export const fetchUsername = async (env: Env, userId: string): Promise<string | null> => {
  const response = await fetch(`${DISCORD_API_BASE_URL}/users/${userId}`, {
    headers: botHeaders(env),
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  const user = await response.json().catch(() => null);
  return isRecord(user) && typeof user.username === "string" ? user.username : null;
};

const BOT_ROLE_CACHE_TTL_MS = 5 * 60_000;

type BotRoleCacheRow = {
  role_ids_json: string;
  expires_at: number;
};

const readCachedBotRoleIds = async (
  env: Env,
  guildId: string,
  botUserId: string,
): Promise<string[] | null> => {
  try {
    const cached = await env.DB.prepare(
      "SELECT role_ids_json, expires_at FROM discord_bot_role_cache WHERE guild_id = ? AND bot_user_id = ?",
    )
      .bind(guildId, botUserId)
      .first<BotRoleCacheRow>();
    if (!cached || cached.expires_at <= Date.now()) {
      return null;
    }
    const parsed = JSON.parse(cached.role_ids_json);
    return Array.isArray(parsed) ? parsed.filter((role): role is string => typeof role === "string") : null;
  } catch {
    return null;
  }
};

const writeCachedBotRoleIds = async (
  env: Env,
  guildId: string,
  botUserId: string,
  roleIds: string[],
) => {
  try {
    await env.DB.prepare(
      "INSERT INTO discord_bot_role_cache (guild_id, bot_user_id, role_ids_json, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, bot_user_id) DO UPDATE SET role_ids_json = excluded.role_ids_json, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP",
    )
      .bind(guildId, botUserId, JSON.stringify(roleIds), Date.now() + BOT_ROLE_CACHE_TTL_MS)
      .run();
  } catch {
    // Cache writes are best-effort; Discord remains the source of truth.
  }
};

export const fetchBotRoleIds = async (
  env: Env,
  guildId: string,
  botUserId: string,
): Promise<string[]> => {
  const cached = await readCachedBotRoleIds(env, guildId, botUserId);
  if (cached) {
    return cached;
  }

  const response = await fetch(`${DISCORD_API_BASE_URL}/guilds/${guildId}/members/${botUserId}`, {
    headers: botHeaders(env),
  }).catch(() => null);
  if (!response?.ok) {
    return [];
  }

  const member = await response.json().catch(() => null);
  const roleIds = isRecord(member) && Array.isArray(member.roles)
    ? member.roles.filter((role): role is string => typeof role === "string")
    : [];
  await writeCachedBotRoleIds(env, guildId, botUserId, roleIds);
  return roleIds;
};

export const editOriginalInteractionResponse = async (
  applicationId: string,
  interactionToken: string,
  data: InteractionMessageData,
) => {
  await fetch(
    `${DISCORD_API_BASE_URL}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    },
  );
};
