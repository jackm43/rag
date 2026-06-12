import { Code, ConnectError } from "@connectrpc/connect";
import { createLocalJWKSet, jwtVerify } from "jose";

import { logger } from "../../../../sdk/ts/src";
import { getJwks, signToken } from "./keys";
import { getApplication } from "./registry";
import { verifyGatewayStsToken } from "./sts-verify";
import type { Env } from "./types";

const CF_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CF_AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";

type ProviderOAuthClients = Record<
  string,
  {
    client_id: string;
    client_secret: string;
  }
>;

type ProviderGrantRow = {
  subject: string;
  application: string;
  refresh_token: string;
  scopes: string;
};

const issuer = (env: Env) => env.GATEWAY_ISSUER.replace(/\/$/, "");

const parseProviderClients = (env: Env): ProviderOAuthClients => {
  const raw = env.PROVIDER_OAUTH_CLIENTS ?? "{}";
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      string | { client_id?: string; client_secret?: string }
    >;
    const clients: ProviderOAuthClients = {};
    for (const [application, value] of Object.entries(parsed)) {
      const credential =
        typeof value === "string"
          ? (JSON.parse(value) as { client_id?: string; client_secret?: string })
          : value;
      if (!credential.client_id || !credential.client_secret) {
        continue;
      }
      clients[application] = {
        client_id: credential.client_id,
        client_secret: credential.client_secret,
      };
    }
    return clients;
  } catch {
    return {};
  }
};

const resolveProviderClient = (env: Env, application: string) => {
  const clients = parseProviderClients(env);
  const client = clients[application];
  if (!client) {
    throw new ConnectError(`provider oauth client is not configured for ${application}`, Code.FailedPrecondition);
  }
  return client;
};

const verifySubjectForApplication = async (env: Env, subjectToken: string, audience: string) => {
  const identity = await verifyGatewayStsToken(env, subjectToken, audience);
  if (!identity) {
    throw new ConnectError("invalid subject token", Code.Unauthenticated);
  }
  return identity;
};

const getGrant = async (env: Env, subject: string, application: string) =>
  env.DB.prepare("SELECT * FROM idp_provider_grants WHERE subject = ? AND application = ?")
    .bind(subject, application)
    .first<ProviderGrantRow>();

const putGrant = async (env: Env, subject: string, application: string, refreshToken: string, scopes: string[]) => {
  await env.DB.prepare(
    `INSERT INTO idp_provider_grants (subject, application, refresh_token, scopes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(subject, application) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       scopes = excluded.scopes,
       updated_at = unixepoch()`,
  )
    .bind(subject, application, refreshToken, JSON.stringify(scopes))
    .run();
};

const refreshProviderAccessToken = async (
  client: { client_id: string; client_secret: string },
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> => {
  const response = await fetch(CF_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
      client_secret: client.client_secret,
    }).toString(),
  });
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new ConnectError(`provider token refresh failed (${response.status})`, Code.Unauthenticated);
  }
  return {
    access_token: body.access_token,
    expires_in: body.expires_in ?? 300,
    refresh_token: body.refresh_token,
  };
};

const providerRedirectURI = (env: Env) => `${issuer(env)}/provider/oauth/callback`;

const withOfflineAccess = (scopes: string[]) =>
  scopes.includes("offline_access") ? scopes : [...scopes, "offline_access"];

const exchangeAuthorizationCode = async (
  client: { client_id: string; client_secret: string },
  code: string,
  redirectURI: string,
): Promise<{ access_token?: string; refresh_token?: string; error?: string; error_description?: string }> => {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectURI,
    client_id: client.client_id,
    client_secret: client.client_secret,
  });
  const response = await fetch(CF_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
};

// The OAuth state binds the callback to the exact subject and application
// that initiated authorization. It is a short-lived gateway-signed JWT so a
// tampered or substituted state cannot bind a grant to a different subject.
const STATE_AUDIENCE = "idp:provider-oauth-state";
const STATE_LIFETIME_SECONDS = 600;

const signState = (env: Env, application: string, subject: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return signToken(env, {
    iss: issuer(env),
    aud: STATE_AUDIENCE,
    sub: subject,
    application,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + STATE_LIFETIME_SECONDS,
  });
};

const verifyState = async (
  env: Env,
  state: string,
): Promise<{ application: string; subject: string } | null> => {
  try {
    const response = await getJwks(env);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { keys: Record<string, unknown>[] };
    const { payload } = await jwtVerify(state, createLocalJWKSet(body), {
      issuer: issuer(env),
      audience: STATE_AUDIENCE,
    });
    if (typeof payload.sub !== "string" || typeof payload.application !== "string") {
      return null;
    }
    return { application: payload.application, subject: payload.sub };
  } catch {
    return null;
  }
};

const buildProviderAuthorizeURL = async (
  env: Env,
  application: string,
  subject: string,
  scopes: string[],
  clientID: string,
): Promise<string> => {
  const state = await signState(env, application, subject);
  const params = new URLSearchParams({
    client_id: clientID,
    response_type: "code",
    redirect_uri: providerRedirectURI(env),
    scope: withOfflineAccess(scopes).join(" "),
    state,
  });
  return `${CF_AUTH_URL}?${params.toString()}`;
};

export const exchangeProviderAccessToken = async (
  env: Env,
  subjectToken: string,
  application: string,
): Promise<{ accessToken: string; expiresIn: number; authorizeUrl?: string }> => {
  const identity = await verifySubjectForApplication(env, subjectToken, application);
  const registered = await getApplication(env, application);
  if (!registered?.providerOauthClientId) {
    throw new ConnectError(`application ${application} has no provider oauth client`, Code.FailedPrecondition);
  }
  const grant = await getGrant(env, identity.subject, application);
  if (!grant) {
    const client = resolveProviderClient(env, application);
    if (client.client_id !== registered.providerOauthClientId) {
      throw new ConnectError(
        `provider oauth client_id mismatch for ${application}`,
        Code.FailedPrecondition,
      );
    }
    return {
      accessToken: "",
      expiresIn: 0,
      authorizeUrl: await buildProviderAuthorizeURL(
        env,
        application,
        identity.subject,
        registered.providerOauthScopes,
        registered.providerOauthClientId,
      ),
    };
  }
  const client = resolveProviderClient(env, application);
  const refreshed = await refreshProviderAccessToken(client, grant.refresh_token);
  if (refreshed.refresh_token && refreshed.refresh_token !== grant.refresh_token) {
    await putGrant(
      env,
      identity.subject,
      application,
      refreshed.refresh_token,
      JSON.parse(grant.scopes || "[]") as string[],
    );
  }
  return { accessToken: refreshed.access_token, expiresIn: refreshed.expires_in };
};

export const completeProviderOAuthCallback = async (
  env: Env,
  code: string,
  state: string,
): Promise<Response> => {
  const payload = await verifyState(env, state);
  if (!payload) {
    return new Response("invalid oauth state", { status: 400 });
  }
  const registered = await getApplication(env, payload.application);
  if (!registered?.providerOauthClientId) {
    return new Response("application is not configured for provider oauth", { status: 400 });
  }
  const client = resolveProviderClient(env, payload.application);
  if (client.client_id !== registered.providerOauthClientId) {
    return new Response("provider oauth client_id mismatch", { status: 400 });
  }
  const redirectURI = providerRedirectURI(env);
  const body = await exchangeAuthorizationCode(client, code, redirectURI);
  if (!body.refresh_token) {
    const detail = body.error_description ?? body.error ?? "no refresh_token in response";
    logger.warn("provider_oauth_code_exchange_failed", {
      application: payload.application,
      client_id: client.client_id,
      detail,
    });
    return new Response(`provider oauth code exchange failed: ${detail}`, { status: 400 });
  }
  await putGrant(env, payload.subject, payload.application, body.refresh_token, registered.providerOauthScopes);
  return new Response("<html><body>Provider authorization complete. Return to the terminal.</body></html>", {
    headers: { "content-type": "text/html" },
  });
};

