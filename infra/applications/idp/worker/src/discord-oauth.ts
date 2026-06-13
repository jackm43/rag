import { ConnectError, Code } from "@connectrpc/connect";

import { logger, resolveSecret } from "@platy/sdk";
import type { Env } from "./types";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_OAUTH = "https://discord.com/api/oauth2";
export const DISCORD_CODE_PREFIX = "dac_";
const PENDING_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 120;

type DiscordUser = { id: string; username: string; global_name?: string | null };
type DiscordGuild = { id: string };

const parseAllowedGuildIds = (raw: string | undefined): Set<string> | null => {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const ids = trimmed
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
};

const allowedRedirectUri = (env: Env, redirectUri: string): boolean => {
  const normalized = redirectUri.split("?")[0];
  return (env.GATEWAY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .some((origin) => normalized === `${origin}/callback`);
};

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return b64url(new Uint8Array(digest));
};

const newCode = (): string => `${DISCORD_CODE_PREFIX}${b64url(crypto.getRandomValues(new Uint8Array(24)))}`;

const issuer = (env: Env) => env.GATEWAY_ISSUER.replace(/\/$/, "");

const requireDiscordConfig = async (env: Env): Promise<{ clientId: string; clientSecret: string }> => {
  const clientId = (await resolveSecret(env.DISCORD_APPLICATION_ID)).trim();
  const clientSecret = (await resolveSecret(env.DISCORD_CLIENT_SECRET)).trim();
  if (!clientId || !clientSecret) {
    throw new ConnectError("discord oauth is not configured", Code.FailedPrecondition);
  }
  return { clientId, clientSecret };
};

const guildAllowed = (env: Env, guilds: DiscordGuild[]): boolean => {
  const allowed = parseAllowedGuildIds(env.ALLOWED_GUILD_IDS);
  if (!allowed) {
    return true;
  }
  return guilds.some((guild) => allowed.has(guild.id));
};

export const discordAuthorizeUrl = (env: Env) => `${issuer(env)}/oauth/discord/authorize`;

export const handleDiscordAuthorize = async (env: Env, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const method = url.searchParams.get("code_challenge_method") ?? "";
  if (!redirectUri || !state || !codeChallenge || method !== "S256") {
    return new Response("invalid authorize request", { status: 400 });
  }
  if (!allowedRedirectUri(env, redirectUri)) {
    return new Response("redirect_uri not allowed", { status: 400 });
  }
  const { clientId } = await requireDiscordConfig(env);
  const callback = `${issuer(env)}/oauth/discord/callback`;
  const expiresAt = Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS;
  await env.DB.prepare(
    "INSERT INTO idp_discord_pending (state, code_challenge, redirect_uri, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(state, codeChallenge, redirectUri, expiresAt)
    .run();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    scope: "identify guilds",
    state,
  });
  return Response.redirect(`${DISCORD_OAUTH}/authorize?${params.toString()}`, 302);
};

const fetchDiscordToken = async (
  env: Env,
  code: string,
): Promise<{ access_token: string }> => {
  const { clientId, clientSecret } = await requireDiscordConfig(env);
  const response = await fetch(`${DISCORD_OAUTH}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${issuer(env)}/oauth/discord/callback`,
    }).toString(),
  });
  if (!response.ok) {
    throw new ConnectError(`discord token exchange failed (${response.status})`, Code.Unauthenticated);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new ConnectError("discord token response missing access_token", Code.Unauthenticated);
  }
  return { access_token: body.access_token };
};

const fetchDiscordIdentity = async (
  accessToken: string,
): Promise<{ user: DiscordUser; guilds: DiscordGuild[] }> => {
  const headers = { authorization: `Bearer ${accessToken}` };
  const [userResponse, guildsResponse] = await Promise.all([
    fetch(`${DISCORD_API}/users/@me`, { headers }),
    fetch(`${DISCORD_API}/users/@me/guilds`, { headers }),
  ]);
  if (!userResponse.ok || !guildsResponse.ok) {
    throw new ConnectError("discord identity fetch failed", Code.Unauthenticated);
  }
  const user = (await userResponse.json()) as DiscordUser;
  const guilds = (await guildsResponse.json()) as DiscordGuild[];
  if (!user.id) {
    throw new ConnectError("discord user id missing", Code.Unauthenticated);
  }
  return { user, guilds };
};

export const handleDiscordCallback = async (env: Env, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) {
    return new Response("missing code or state", { status: 400 });
  }
  const pending = await env.DB.prepare("SELECT * FROM idp_discord_pending WHERE state = ?")
    .bind(state)
    .first<{ state: string; code_challenge: string; redirect_uri: string; expires_at: number }>();
  if (!pending) {
    return new Response("invalid state", { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM idp_discord_pending WHERE state = ?").bind(state).run();
  if (now >= pending.expires_at) {
    return new Response("authorize session expired", { status: 400 });
  }
  try {
    const token = await fetchDiscordToken(env, code);
    const { user, guilds } = await fetchDiscordIdentity(token.access_token);
    if (!guildAllowed(env, guilds)) {
      logger.info("discord_guild_rejected", { subject: user.id });
      return new Response("not a member of an allowed server", { status: 403 });
    }
    const gatewayCode = newCode();
    const expiresAt = now + CODE_TTL_SECONDS;
    await env.DB.prepare(
      "INSERT INTO idp_oauth_codes (code, subject, username, code_challenge, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(gatewayCode, user.id, user.global_name ?? user.username, pending.code_challenge, pending.redirect_uri, expiresAt)
      .run();
    const redirect = new URL(pending.redirect_uri);
    redirect.searchParams.set("code", gatewayCode);
    redirect.searchParams.set("state", state);
    return Response.redirect(redirect.toString(), 302);
  } catch (error) {
    logger.warn("discord_callback_failed", { error: String(error) });
    return new Response("discord login failed", { status: 500 });
  }
};

export const redeemDiscordCode = async (
  env: Env,
  request: { authorizationCode: string; codeVerifier: string; redirectUri: string },
): Promise<{ subject: string; username: string }> => {
  if (!request.codeVerifier || !request.redirectUri) {
    throw new ConnectError(
      "authorization_code requires code_verifier and redirect_uri",
      Code.InvalidArgument,
    );
  }
  if (!request.authorizationCode.startsWith(DISCORD_CODE_PREFIX)) {
    throw new ConnectError("invalid discord authorization code", Code.InvalidArgument);
  }
  if (!allowedRedirectUri(env, request.redirectUri)) {
    throw new ConnectError("redirect_uri not allowed", Code.PermissionDenied);
  }
  const challenge = await sha256(request.codeVerifier);
  const row = await env.DB.prepare("SELECT * FROM idp_oauth_codes WHERE code = ?")
    .bind(request.authorizationCode)
    .first<{
      code: string;
      subject: string;
      username: string;
      code_challenge: string;
      redirect_uri: string;
      expires_at: number;
    }>();
  if (!row) {
    throw new ConnectError("invalid authorization code", Code.Unauthenticated);
  }
  await env.DB.prepare("DELETE FROM idp_oauth_codes WHERE code = ?").bind(row.code).run();
  const now = Math.floor(Date.now() / 1000);
  if (now >= row.expires_at) {
    throw new ConnectError("authorization code expired", Code.Unauthenticated);
  }
  if (row.code_challenge !== challenge || row.redirect_uri !== request.redirectUri) {
    throw new ConnectError("pkce verification failed", Code.Unauthenticated);
  }
  logger.info("discord_code_redeemed", { subject: row.subject, username: row.username });
  return { subject: row.subject, username: row.username };
};
