import { generateHandle } from "../store";
import {
  ConnectorError,
  type ConnectorProvider,
  type ConnectorStrategy,
  type ResolvedToken,
  type StrategyContext,
} from "../types";
import { basicAuth, expiresAtFrom, postForm, resolveSecret } from "./shared";

// oauth2 provider: the two OAuth-shaped flows, in one cohesive file behind the
// strategy interface. Both keep the client secret and any resulting token
// broker-side; a caller sees only the handle (and, via connector.token, a
// short-lived access token when it must call the provider directly).
//
//   oauth2_client_credentials (2LO): the broker performs the client_credentials
//     grant against the token endpoint and caches the access token to ~expiry.
//   oauth2_authorization_code (3LO): tokens are per-subject, obtained via a user
//     consent redirect (begin/complete) and stored in the OAuth token store keyed
//     by (connectorId, subject), refreshed via refresh_token on use. The
//     reference 3LO connector is `discord-user` (registry.ts); the state minted
//     at begin is persisted and consumed once at complete, so a completion with
//     an unknown, replayed, or another-subject's state fails closed.

// The OAuth client id: a literal `clientId` when the registry commits one, else
// resolved through `clientIdRef` (a {provider, ref}, mirroring github_app's
// appId) so a deployment-specific id can live beside the client secret. A
// connector with neither is misconfigured and fails closed.
const resolveClientId = async (ctx: StrategyContext): Promise<string> => {
  if (ctx.connector.clientId) {
    return ctx.connector.clientId;
  }
  if (ctx.connector.clientIdRef) {
    return resolveSecret(ctx.env, ctx.connector.clientIdRef);
  }
  throw new ConnectorError(500, "client_id_unresolved");
};

// ---------------------------------------------------------------------------
// oauth2_client_credentials (2LO)
// ---------------------------------------------------------------------------

const ccCacheKey = (ctx: StrategyContext): string =>
  `cc:${ctx.connector.id}:${[...ctx.scopes].sort().join(" ")}`;

const resolveClientCredentialsToken = async (ctx: StrategyContext): Promise<ResolvedToken> => {
  const cached = ctx.tokenCache.get(ccCacheKey(ctx));
  if (cached) {
    return cached;
  }
  if (!ctx.connector.tokenUrl) {
    throw new ConnectorError(500, "client_credentials_misconfigured");
  }
  const clientId = await resolveClientId(ctx);
  const secret = await resolveSecret(ctx.env, ctx.connector.secret);
  const scopes = ctx.scopes.length ? ctx.scopes : ctx.connector.defaultScopes ?? [];
  const body = await postForm(
    ctx.fetch,
    ctx.connector.tokenUrl,
    { grant_type: "client_credentials", ...(scopes.length ? { scope: scopes.join(" ") } : {}) },
    { authorization: basicAuth(clientId, secret) },
  );
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new ConnectorError(502, "token_endpoint_no_access_token");
  }
  const token: ResolvedToken = {
    value: accessToken,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    expiresAt: expiresAtFrom(body.expires_in, ctx.now()),
  };
  ctx.tokenCache.set(ccCacheKey(ctx), token);
  return token;
};

const clientCredentialsStrategy: ConnectorStrategy = {
  kind: "oauth2_client_credentials",
  prepare: async (ctx) => {
    // Mint (and cache) a grant token now: validates the client credentials and
    // means the first use is warm. The handle expires with the token.
    const token = await resolveClientCredentialsToken(ctx);
    const ttl = (ctx.connector.grantTtlSeconds ?? 300) + Math.floor(ctx.now() / 1000);
    return { expiresAt: token.expiresAt ? Math.min(ttl, token.expiresAt) : ttl };
  },
  inject: async (ctx) => {
    const token = await resolveClientCredentialsToken(ctx);
    return { authorization: `${token.tokenType} ${token.value}`, ...(ctx.connector.staticHeaders ?? {}) };
  },
  token: resolveClientCredentialsToken,
};

// ---------------------------------------------------------------------------
// oauth2_authorization_code (3LO)
// ---------------------------------------------------------------------------

// The redirect_uri sent on begin AND complete (providers require the exchange
// to repeat the begin value exactly). The connector CONFIG is authoritative —
// the registry commits the callback convention (CONNECTORS.md) — with a
// caller-supplied param accepted only when the config names none.
const redirectUri = (ctx: StrategyContext): string => {
  if (ctx.connector.redirectUri) {
    return ctx.connector.redirectUri;
  }
  const uri = ctx.params.redirectUri;
  if (typeof uri !== "string" || uri.length === 0) {
    throw new ConnectorError(400, "redirect_uri_required");
  }
  return uri;
};

const resolveAuthorizationCodeToken = async (ctx: StrategyContext): Promise<ResolvedToken> => {
  const stored = await ctx.oauthTokens.get(ctx.connector.id, ctx.subject);
  if (!stored) {
    throw new ConnectorError(403, "authorization_required");
  }
  const stillValid = stored.expiresAt === undefined || stored.expiresAt * 1000 - 30_000 > ctx.now();
  if (stillValid) {
    return { value: stored.accessToken, tokenType: "Bearer", expiresAt: stored.expiresAt };
  }
  if (!stored.refreshToken || !ctx.connector.tokenUrl) {
    throw new ConnectorError(403, "authorization_expired");
  }
  const clientId = await resolveClientId(ctx);
  const secret = await resolveSecret(ctx.env, ctx.connector.secret);
  const body = await postForm(ctx.fetch, ctx.connector.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: clientId,
    client_secret: secret,
  });
  const accessToken = body.access_token;
  if (typeof accessToken !== "string") {
    throw new ConnectorError(502, "refresh_failed");
  }
  const expiresAt = expiresAtFrom(body.expires_in, ctx.now());
  await ctx.oauthTokens.put(ctx.connector.id, ctx.subject, {
    accessToken,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : stored.refreshToken,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    scopes: stored.scopes,
  });
  return { value: accessToken, tokenType: "Bearer", expiresAt };
};

const authorizationCodeStrategy: ConnectorStrategy = {
  kind: "oauth2_authorization_code",
  prepare: async (ctx) => {
    // A grant is only issued once the subject has authorized; resolve validates
    // (and refreshes) the stored tokens.
    const token = await resolveAuthorizationCodeToken(ctx);
    const ttl = (ctx.connector.grantTtlSeconds ?? 300) + Math.floor(ctx.now() / 1000);
    return { expiresAt: token.expiresAt ? Math.min(ttl, token.expiresAt) : ttl };
  },
  inject: async (ctx) => {
    const token = await resolveAuthorizationCodeToken(ctx);
    return { authorization: `Bearer ${token.value}`, ...(ctx.connector.staticHeaders ?? {}) };
  },
  token: resolveAuthorizationCodeToken,
  beginAuthorization: async (ctx) => {
    if (!ctx.connector.authorizationUrl) {
      throw new ConnectorError(500, "authorization_misconfigured");
    }
    const clientId = await resolveClientId(ctx);
    // The state is a high-entropy handle, PERSISTED against the subject the
    // consent was begun for. completeAuthorization consumes it (single use), so
    // an unknown/replayed/foreign state can never bind tokens to a subject.
    const state = generateHandle();
    await ctx.oauthStates.put(ctx.connector.id, state, ctx.subject);
    const scopes = ctx.scopes.length ? ctx.scopes : ctx.connector.defaultScopes ?? [];
    const url = new URL(ctx.connector.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri(ctx));
    url.searchParams.set("state", state);
    if (scopes.length) {
      url.searchParams.set("scope", scopes.join(" "));
    }
    return { url: url.toString(), state };
  },
  completeAuthorization: async (ctx) => {
    const code = ctx.params.code;
    if (typeof code !== "string" || code.length === 0) {
      throw new ConnectorError(400, "authorization_code_required");
    }
    const state = ctx.params.state;
    if (typeof state !== "string" || state.length === 0) {
      throw new ConnectorError(400, "authorization_state_required");
    }
    if (!ctx.connector.tokenUrl) {
      throw new ConnectorError(500, "authorization_misconfigured");
    }
    // The state must be one THIS broker minted, still pending, and minted for
    // THIS subject. Consuming makes it single-use; a mismatch denies before the
    // code is ever exchanged, so a forged callback can't store foreign tokens.
    const mintedFor = await ctx.oauthStates.consume(ctx.connector.id, state);
    if (mintedFor === null) {
      throw new ConnectorError(403, "authorization_state_unknown_or_expired");
    }
    if (mintedFor !== ctx.subject) {
      throw new ConnectorError(403, "authorization_state_subject_mismatch");
    }
    const clientId = await resolveClientId(ctx);
    const secret = await resolveSecret(ctx.env, ctx.connector.secret);
    const body = await postForm(ctx.fetch, ctx.connector.tokenUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(ctx),
      client_id: clientId,
      client_secret: secret,
    });
    const accessToken = body.access_token;
    if (typeof accessToken !== "string") {
      throw new ConnectorError(502, "authorization_exchange_failed");
    }
    const expiresAt = expiresAtFrom(body.expires_in, ctx.now());
    await ctx.oauthTokens.put(ctx.connector.id, ctx.subject, {
      accessToken,
      ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      scopes: ctx.scopes.length ? ctx.scopes : ctx.connector.defaultScopes ?? [],
    });
  },
};

export const oauth2Provider: ConnectorProvider = {
  name: "oauth2",
  kinds: ["oauth2_client_credentials", "oauth2_authorization_code"],
  strategies: [clientCredentialsStrategy, authorizationCodeStrategy],
};
