import { boundaryClients, type EgressCaller } from "@rag/egress/outbound/clients";
import { logger } from "@rag/logger";
import { DISCORD_API_BASE_URL, type DiscordChannel, type DiscordMessage, type Env } from "../../contracts";
import { isDiscordMessage } from "../../contracts";
import { isRecord } from "@rag/contracts-core";
import type { Subject } from "@rag/service-kit";

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

const auditLogReasonHeader = (reason: string) => encodeURIComponent(reason);

const discordJsonRequest = async (
  env: Env,
  caller: EgressCaller,
  path: string,
  init: RequestInit = {},
  options: { nullOnError?: boolean } = {},
): Promise<unknown> => {
  const response = await boundaryClients(env, caller).discordRest(`${DISCORD_API_BASE_URL}${path}`, init);

  if (!response.ok) {
    if (options.nullOnError) {
      return null;
    }
    throw new Error(`Discord API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json().catch(() => null);
};

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
  attachments?: Array<{
    id: string;
    filename: string;
    description?: string;
  }>;
};

export type InteractionResponseFile = {
  name: string;
  contentType: string;
  data: BlobPart;
};

export const postChannelMessage = async (
  env: Env,
  caller: EgressCaller,
  channelId: string,
  content: string,
) =>
  boundaryClients(env, caller).discordRest(`${DISCORD_API_BASE_URL}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content,
      allowed_mentions: {
        parse: [],
      },
    }),
  });

export const postChannelMessageForSubject = async (
  env: Env,
  caller: EgressCaller,
  channelId: string,
  content: string,
  subject: Subject,
) =>
  boundaryClients(env, caller).discordRest(
    `${DISCORD_API_BASE_URL}/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content,
        allowed_mentions: {
          parse: [],
        },
      }),
    },
    { subject },
  );

export const createThreadFromMessage = async (
  env: Env,
  caller: EgressCaller,
  channelId: string,
  messageId: string,
  name: string,
): Promise<DiscordChannel | null> => {
  const payload = await discordJsonRequest(env, caller, threadsRoute(channelId, messageId), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-audit-log-reason": auditLogReasonHeader("Ragbot AI conversation"),
    },
    body: JSON.stringify({
      name,
      auto_archive_duration: DISCORD_THREAD_AUTO_ARCHIVE_ONE_DAY,
    }),
  });
  return isDiscordChannel(payload) ? payload : null;
};

export const createThreadWithoutMessage = async (
  env: Env,
  caller: EgressCaller,
  channelId: string,
  name: string,
): Promise<DiscordChannel | null> => {
  const payload = await discordJsonRequest(env, caller, threadsRoute(channelId), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-audit-log-reason": auditLogReasonHeader("Ragbot /ask conversation"),
    },
    body: JSON.stringify({
      name,
      type: DISCORD_CHANNEL_TYPE_PUBLIC_THREAD_CREATE,
      auto_archive_duration: DISCORD_THREAD_AUTO_ARCHIVE_ONE_DAY,
    }),
  });
  return isDiscordChannel(payload) ? payload : null;
};

export const fetchChannel = async (
  env: Env,
  caller: EgressCaller,
  channelId: string,
): Promise<DiscordChannel | null> => {
  const payload = await discordJsonRequest(env, caller, channelRoute(channelId)).catch(() => null);
  return isDiscordChannel(payload) ? payload : null;
};

export const fetchChannelMessages = async (
  env: Env,
  caller: EgressCaller,
  channelId: string,
  options: { before?: string; limit?: number } = {},
): Promise<DiscordMessage[]> => {
  const params = new URLSearchParams();
  if (options.before) {
    params.set("before", options.before);
  }
  params.set("limit", String(options.limit ?? 12));

  const payload = await discordJsonRequest(
    env,
    caller,
    `/channels/${channelId}/messages?${params}`,
    {},
    { nullOnError: true },
  );
  return Array.isArray(payload) ? payload.filter(isDiscordMessage) : [];
};

export const fetchMessage = async (
  env: Env,
  caller: EgressCaller,
  channelId: string,
  messageId: string,
): Promise<DiscordMessage | null> => {
  const payload = await discordJsonRequest(
    env,
    caller,
    `/channels/${channelId}/messages/${messageId}`,
    {},
    { nullOnError: true },
  );
  return isDiscordMessage(payload) ? payload : null;
};

export const fetchUsername = async (
  env: Env,
  caller: EgressCaller,
  userId: string,
): Promise<string | null> => {
  const user = await discordJsonRequest(env, caller, `/users/${userId}`, {}, { nullOnError: true })
    .catch(() => null);
  return isRecord(user) && typeof user.username === "string" ? user.username : null;
};

const BOT_ROLE_CACHE_TTL_MS = 5 * 60_000;
const botRoleCache = new Map<string, { roleIds: string[]; expiresAt: number }>();

export const fetchBotRoleIds = async (
  env: Env,
  caller: EgressCaller,
  guildId: string,
  botUserId: string,
): Promise<string[]> => {
  const key = `${guildId}:${botUserId}`;
  const cached = botRoleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.roleIds;
  }

  const response = await boundaryClients(env, caller)
    .discordRest(`${DISCORD_API_BASE_URL}/guilds/${guildId}/members/${botUserId}`)
    .catch(() => null);
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
  env: Env,
  caller: EgressCaller,
  applicationId: string,
  interactionToken: string,
  data: InteractionMessageData,
  files: InteractionResponseFile[] = [],
  subject?: Subject,
): Promise<boolean> => {
  const body = files.length > 0
    ? (() => {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(data));
      files.forEach((file, index) => {
        form.append(
          `files[${index}]`,
          new Blob([file.data], { type: file.contentType }),
          file.name,
        );
      });
      return form;
    })()
    : JSON.stringify(data);

  const response = await boundaryClients(env, caller).discordWebhook(
    `${DISCORD_API_BASE_URL}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: files.length > 0 ? undefined : { "content-type": "application/json" },
      body,
    },
    subject ? { subject } : undefined,
  );
  if (!response.ok) {
    // Never log the interaction token: it authenticates webhook edits.
    logger.warn("interaction_edit_rejected", { status: response.status, applicationId });
  }
  return response.ok;
};
