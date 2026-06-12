import { DISCORD_API_BASE_URL, type DiscordMessage, type Env } from "./types";

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
    body: JSON.stringify({ content }),
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
  return (await response.json()) as DiscordMessage[];
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
  return (await response.json()) as DiscordMessage;
};

export const fetchUsername = async (env: Env, userId: string): Promise<string | null> => {
  const response = await fetch(`${DISCORD_API_BASE_URL}/users/${userId}`, {
    headers: botHeaders(env),
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  const user = (await response.json()) as { username?: string };
  return user.username ?? null;
};

export const fetchBotUserId = async (env: Env): Promise<string | null> => {
  const response = await fetch(`${DISCORD_API_BASE_URL}/users/@me`, {
    headers: botHeaders(env),
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  const user = (await response.json()) as { id?: string };
  return user.id ?? null;
};

const BOT_ROLE_CACHE_TTL_MS = 5 * 60_000;
const botRoleCache = new Map<string, { roleIds: string[]; expiresAt: number }>();

export const fetchBotRoleIds = async (
  env: Env,
  guildId: string,
  botUserId: string,
): Promise<string[]> => {
  const key = `${guildId}:${botUserId}`;
  const cached = botRoleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.roleIds;
  }
  const response = await fetch(`${DISCORD_API_BASE_URL}/guilds/${guildId}/members/${botUserId}`, {
    headers: botHeaders(env),
  }).catch(() => null);
  if (!response?.ok) {
    return cached?.roleIds ?? [];
  }
  const member = (await response.json()) as { roles?: string[] };
  const roleIds = (member.roles ?? []).map(String);
  botRoleCache.set(key, { roleIds, expiresAt: Date.now() + BOT_ROLE_CACHE_TTL_MS });
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
