import { DISCORD_API_BASE_URL, type Env } from "../contracts";

// In-process outbound helpers for the Discord edges. Outbound HTTP is a plain
// fetch with the credential injected and a timeout applied — there is no egress
// worker and no shared boundary package. Hosts are fixed and known at the call
// site (discord.com), so there is no host allowlist to enforce here.

const DISCORD_TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 30_000;
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

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
