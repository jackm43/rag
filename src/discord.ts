import { REST, type ResponseLike, type RESTOptions } from "@discordjs/rest";

import { DISCORD_API_BASE_URL, type DiscordChannel, type DiscordMessage, type Env } from "./types";
import { isDiscordMessage, isRecord } from "./validation";

const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD = 11;
const DISCORD_CHANNEL_TYPE_PRIVATE_THREAD = 12;
const DISCORD_CHANNEL_TYPE_ANNOUNCEMENT_THREAD = 10;
const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD_CREATE = 11;
const DISCORD_THREAD_AUTO_ARCHIVE_ONE_DAY = 1440;

const channelRoute = (channelId: string) => `/channels/${channelId}` as const;
const threadsRoute = (channelId: string, messageId?: string) =>
  messageId
    ? `/channels/${channelId}/messages/${messageId}/threads` as const
    : `/channels/${channelId}/threads` as const;

const botHeaders = (env: Env) => ({
  authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
});

const makeDiscordRequest = async (
  url: Parameters<RESTOptions["makeRequest"]>[0],
  init: Parameters<RESTOptions["makeRequest"]>[1],
): Promise<ResponseLike> => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers as HeadersInit,
    body: init.body as BodyInit | null | undefined,
    signal: init.signal as AbortSignal | null | undefined,
  });
  return {
    body: null,
    bodyUsed: response.bodyUsed,
    headers: response.headers as ResponseLike["headers"],
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    arrayBuffer: () => response.arrayBuffer(),
    json: () => response.json(),
    text: () => response.text(),
  };
};

const discordRest = (env: Env) =>
  new REST({
    version: "10",
    makeRequest: makeDiscordRequest,
  }).setToken(env.DISCORD_BOT_TOKEN);

const isDiscordChannel = (value: unknown): value is DiscordChannel =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.type === "number" &&
  (value.parent_id === undefined || value.parent_id === null || typeof value.parent_id === "string") &&
  (value.name === undefined || typeof value.name === "string") &&
  (value.thread_metadata === undefined || isRecord(value.thread_metadata));

export const isThreadChannel = (channel: DiscordChannel) =>
  channel.type === DISCORD_CHANNEL_TYPE_PUBLIC_THREAD ||
  channel.type === DISCORD_CHANNEL_TYPE_PRIVATE_THREAD ||
  channel.type === DISCORD_CHANNEL_TYPE_ANNOUNCEMENT_THREAD;

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

export const createThreadFromMessage = async (
  env: Env,
  channelId: string,
  messageId: string,
  name: string,
): Promise<DiscordChannel | null> => {
  const payload = await discordRest(env).post(threadsRoute(channelId, messageId), {
    body: {
      name,
      auto_archive_duration: DISCORD_THREAD_AUTO_ARCHIVE_ONE_DAY,
    },
    reason: "Ragbot AI conversation",
  });
  return isDiscordChannel(payload) ? payload : null;
};

export const createThreadWithoutMessage = async (
  env: Env,
  channelId: string,
  name: string,
): Promise<DiscordChannel | null> => {
  const payload = await discordRest(env).post(threadsRoute(channelId), {
    body: {
      name,
      type: DISCORD_CHANNEL_TYPE_PUBLIC_THREAD_CREATE,
      auto_archive_duration: DISCORD_THREAD_AUTO_ARCHIVE_ONE_DAY,
    },
    reason: "Ragbot /ask conversation",
  });
  return isDiscordChannel(payload) ? payload : null;
};

export const fetchChannel = async (env: Env, channelId: string): Promise<DiscordChannel | null> => {
  const payload = await discordRest(env).get(channelRoute(channelId)).catch(() => null);
  return isDiscordChannel(payload) ? payload : null;
};

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

  const member = await response.json().catch(() => null);
  const roleIds = isRecord(member) && Array.isArray(member.roles)
    ? member.roles.filter((role): role is string => typeof role === "string")
    : [];
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
