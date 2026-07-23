// Discord REST client and outbound HTTP for the collapsed worker. Ported from
// packages/discord/api/{http,index}.ts (REST + outbound fetch) plus the
// media-capable interaction edits from packages/discord/domain/responder.ts.
//
// Outbound HTTP is a plain fetch with the credential injected and a timeout
// applied — there is no egress worker and no shared boundary package. Hosts are
// fixed and known at the call site (discord.com), so there is no host allowlist
// to enforce here. The former DISCORD_OUTBOX / RESPONDER queue+binding hops are
// replaced by the direct egress helpers (sendChannelReply / sendInteractionEdit
// / sendInteractionMediaEdit) at the bottom of this module.
import type { Env } from "../env";
import {
  DISCORD_API_BASE_URL,
  MAX_DISCORD_MESSAGE_LENGTH,
  isDiscordMessage,
  isRecord,
  type DiscordChannel,
  type DiscordMessage,
  type ResponderAttachment,
} from "./contracts";
import { logger } from "./logger";
import { sanitizeAiText } from "./ai/ai";

const DISCORD_TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 30_000;
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD = 11;
const DISCORD_CHANNEL_TYPE_PRIVATE_THREAD = 12;
const DISCORD_CHANNEL_TYPE_ANNOUNCEMENT_THREAD = 10;
const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD_CREATE = 11;
const DISCORD_THREAD_AUTO_ARCHIVE_ONE_DAY = 1440;

const DISCORD_MESSAGE_HARD_LIMIT = 2000;
const EMPTY_REPLY_FALLBACK = "I could not generate a response.";

// --- outbound HTTP ---

const withTimeout = (init: RequestInit, ms: number): RequestInit => ({
  ...init,
  signal: init.signal ?? AbortSignal.timeout(ms),
});

// Authenticated Discord REST fetch: joins `path` onto the API base, injects the
// bot token, and applies the request timeout.
export const discordApiFetch = (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  return fetch(`${DISCORD_API_BASE_URL}${path}`, { ...withTimeout(init, DISCORD_TIMEOUT_MS), headers });
};

// Interaction-webhook fetch (full URL): the interaction token in the URL is the
// authentication, so NO bot token is sent.
export const discordWebhookFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, withTimeout(init, DISCORD_TIMEOUT_MS));

// Thrown when a media response's declared size exceeds the cap. Callers may
// treat it as a soft failure (skip the attachment) rather than a hard error.
export class MediaTooLargeError extends Error {}

// Download generated media from an arbitrary provider host. No credential; a
// timeout plus a content-length cap bound it (the one call that faces
// non-fixed hosts).
export const fetchMedia = async (url: string): Promise<Response> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
  const contentLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(contentLength) && contentLength > MEDIA_MAX_BYTES) {
    throw new MediaTooLargeError(`media response exceeds ${MEDIA_MAX_BYTES} bytes`);
  }
  return response;
};

// --- REST client ---

const channelRoute = (channelId: string) => `/channels/${channelId}` as const;
const threadsRoute = (channelId: string, messageId?: string) =>
  messageId
    ? `/channels/${channelId}/messages/${messageId}/threads` as const
    : `/channels/${channelId}/threads` as const;

const auditLogReasonHeader = (reason: string) => encodeURIComponent(reason);

const discordJsonRequest = async (
  env: Env,
  path: string,
  init: RequestInit = {},
  options: { nullOnError?: boolean } = {},
): Promise<unknown> => {
  const response = await discordApiFetch(env, path, init);

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
  channelId: string,
  content: string,
) =>
  discordApiFetch(env, `/channels/${channelId}/messages`, {
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

export const createThreadFromMessage = async (
  env: Env,
  channelId: string,
  messageId: string,
  name: string,
): Promise<DiscordChannel | null> => {
  const payload = await discordJsonRequest(env, threadsRoute(channelId, messageId), {
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
  channelId: string,
  name: string,
): Promise<DiscordChannel | null> => {
  const payload = await discordJsonRequest(env, threadsRoute(channelId), {
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
  channelId: string,
): Promise<DiscordChannel | null> => {
  const payload = await discordJsonRequest(env, channelRoute(channelId)).catch(() => null);
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

  const payload = await discordJsonRequest(
    env,
    `/channels/${channelId}/messages?${params}`,
    {},
    { nullOnError: true },
  );
  return Array.isArray(payload) ? payload.filter(isDiscordMessage) : [];
};

export const fetchMessage = async (
  env: Env,
  channelId: string,
  messageId: string,
): Promise<DiscordMessage | null> => {
  const payload = await discordJsonRequest(
    env,
    `/channels/${channelId}/messages/${messageId}`,
    {},
    { nullOnError: true },
  );
  return isDiscordMessage(payload) ? payload : null;
};

export const fetchUsername = async (
  env: Env,
  userId: string,
): Promise<string | null> => {
  const user = await discordJsonRequest(env, `/users/${userId}`, {}, { nullOnError: true })
    .catch(() => null);
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

  const response = await discordApiFetch(env, `/guilds/${guildId}/members/${botUserId}`)
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
  applicationId: string,
  interactionToken: string,
  data: InteractionMessageData,
  files: InteractionResponseFile[] = [],
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

  const response = await discordWebhookFetch(
    `${DISCORD_API_BASE_URL}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: files.length > 0 ? undefined : { "content-type": "application/json" },
      body,
    },
  );
  if (!response.ok) {
    // Never log the interaction token: it authenticates webhook edits.
    logger.warn("interaction_edit_rejected", { status: response.status, applicationId });
  }
  return response.ok;
};

// --- final output policy (ported from responder.ts) ---

// Model output can carry attacker-chosen links (prompt injection through other
// users' messages), and a rendered embed gives a phishing link the bot's
// authority. Wrapping URLs in <angle brackets> keeps them clickable but stops
// Discord from rendering embeds/previews. Code spans are left alone, and
// already-wrapped URLs are not double-wrapped.
const CODE_SEGMENT_PATTERN = /(```[\s\S]*?```|`[^`\n]*`)/g;
const URL_PATTERN = /<?https?:\/\/[^\s<>]+>?/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,!?;:]+$/;

const wrapBareUrls = (segment: string) =>
  segment.replace(URL_PATTERN, (match) => {
    if (match.startsWith("<")) {
      return match;
    }
    const trailingPunctuation = TRAILING_PUNCTUATION_PATTERN.exec(match)?.[0] ?? "";
    const url = trailingPunctuation ? match.slice(0, -trailingPunctuation.length) : match;
    return `<${url}>${trailingPunctuation}`;
  });

export const suppressUrlEmbeds = (text: string) =>
  text
    .split(CODE_SEGMENT_PATTERN)
    .map((segment, index) => (index % 2 === 1 ? segment : wrapBareUrls(segment)))
    .join("");

// Final output policy for AI-generated channel replies. This is the single
// Discord egress choke point: callers ship raw model text and this is the only
// place mention/ID sanitisation, URL embed suppression, and the message length
// cap are applied before anything reaches Discord.
export const finalizeAiReplyText = (value: string) => {
  const text = suppressUrlEmbeds(sanitizeAiText(value));
  return text.length > 0 ? text.slice(0, MAX_DISCORD_MESSAGE_LENGTH) : EMPTY_REPLY_FALLBACK;
};

// Interaction-edit content is command feedback (prompt echoes, failure
// notices), not model output, so it only gets the hard length cap plus the
// allowed_mentions lockdown.
const truncateInteractionContent = (value: string) => value.slice(0, DISCORD_MESSAGE_HARD_LIMIT);

// --- direct Discord egress (replaces the DISCORD_OUTBOX / RESPONDER hops) ---

export const sendChannelReply = async (
  env: Env,
  channelId: string,
  content: string,
) => postChannelMessage(env, channelId, finalizeAiReplyText(content));

export const sendInteractionEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
) =>
  editOriginalInteractionResponse(env, applicationId, interactionToken, {
    content: truncateInteractionContent(content),
    allowed_mentions: { parse: [] },
  });

export const sendInteractionMediaEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
  attachment: ResponderAttachment,
) =>
  editOriginalInteractionResponse(
    env,
    applicationId,
    interactionToken,
    {
      content: truncateInteractionContent(content),
      allowed_mentions: { parse: [] },
      attachments: [{ id: "0", filename: attachment.name }],
    },
    [attachment],
  );
