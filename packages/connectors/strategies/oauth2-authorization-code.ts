import { generateHandle } from "../store";
import {
  ConnectorError,
  type ConnectorStrategy,
  type ResolvedToken,
  type StrategyContext,
} from "../types";
import { expiresAtFrom, postForm, requireSecret } from "./shared";

// oauth2_authorization_code (3LO): tokens are per-subject, obtained via a user
// consent redirect and stored in the OAuth token store keyed by (connectorId,
// subject). This strategy defines the full seam — begin/complete plus a
// refreshing resolve — but no 3LO provider is wired in this task (Discord is a
// follow-up). The storage and refresh are real so wiring a provider is only a
// config entry.
//
// beginAuthorization returns the provider consent URL + an opaque state the
// caller round-trips; completeAuthorization exchanges the returned code for
// tokens and persists them. On use, resolve reads the stored tokens, refreshing
// via refresh_token when expired, and fails closed (403 authorization_required)
// when the subject has never authorized.

const redirectUri = (ctx: StrategyContext): string => {
  const uri = ctx.params.redirectUri;
  if (typeof uri !== "string" || uri.length === 0) {
    throw new ConnectorError(400, "redirect_uri_required");
  }
  return uri;
};

const resolveToken = async (ctx: StrategyContext): Promise<ResolvedToken> => {
  const stored = await ctx.oauthTokens.get(ctx.connector.id, ctx.subject);
  if (!stored) {
    throw new ConnectorError(403, "authorization_required");
  }
  const stillValid = stored.expiresAt === undefined || stored.expiresAt * 1000 - 30_000 > ctx.now();
  if (stillValid) {
    return { value: stored.accessToken, tokenType: "Bearer", expiresAt: stored.expiresAt };
  }
  if (!stored.refreshToken || !ctx.connector.tokenUrl || !ctx.connector.clientId) {
    throw new ConnectorError(403, "authorization_expired");
  }
  const secret = requireSecret(ctx.env, ctx.connector.secretBinding);
  const body = await postForm(ctx.fetch, ctx.connector.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: ctx.connector.clientId,
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

export const oauth2AuthorizationCodeStrategy: ConnectorStrategy = {
  kind: "oauth2_authorization_code",
  prepare: async (ctx) => {
    // A grant is only issued once the subject has authorized; resolve validates
    // (and refreshes) the stored tokens.
    const token = await resolveToken(ctx);
    const ttl = (ctx.connector.grantTtlSeconds ?? 300) + Math.floor(ctx.now() / 1000);
    return { expiresAt: token.expiresAt ? Math.min(ttl, token.expiresAt) : ttl };
  },
  inject: async (ctx) => {
    const token = await resolveToken(ctx);
    return { authorization: `Bearer ${token.value}`, ...(ctx.connector.staticHeaders ?? {}) };
  },
  token: resolveToken,
  beginAuthorization: async (ctx) => {
    if (!ctx.connector.authorizationUrl || !ctx.connector.clientId) {
      throw new ConnectorError(500, "authorization_misconfigured");
    }
    const state = generateHandle();
    const scopes = ctx.scopes.length ? ctx.scopes : ctx.connector.defaultScopes ?? [];
    const url = new URL(ctx.connector.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", ctx.connector.clientId);
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
    if (!ctx.connector.tokenUrl || !ctx.connector.clientId) {
      throw new ConnectorError(500, "authorization_misconfigured");
    }
    const secret = requireSecret(ctx.env, ctx.connector.secretBinding);
    const body = await postForm(ctx.fetch, ctx.connector.tokenUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(ctx),
      client_id: ctx.connector.clientId,
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
