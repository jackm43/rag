import { ConnectorError, type ResolvedToken, type StrategyContext, type ConnectorStrategy } from "../types";
import { basicAuth, expiresAtFrom, postForm, requireSecret } from "./shared";

// oauth2_client_credentials (2LO): the broker performs the client_credentials
// grant against the connector's token endpoint and caches the access token until
// shortly before expiry. The client secret and the resulting token stay
// broker-side; a caller sees only the handle (and, via connector.token, a
// short-lived access token when it must call the provider directly).

const cacheKey = (ctx: StrategyContext): string =>
  `cc:${ctx.connector.id}:${[...ctx.scopes].sort().join(" ")}`;

const resolveToken = async (ctx: StrategyContext): Promise<ResolvedToken> => {
  const cached = ctx.tokenCache.get(cacheKey(ctx));
  if (cached) {
    return cached;
  }
  if (!ctx.connector.tokenUrl || !ctx.connector.clientId) {
    throw new ConnectorError(500, "client_credentials_misconfigured");
  }
  const secret = requireSecret(ctx.env, ctx.connector.secretBinding);
  const scopes = ctx.scopes.length ? ctx.scopes : ctx.connector.defaultScopes ?? [];
  const body = await postForm(
    ctx.fetch,
    ctx.connector.tokenUrl,
    { grant_type: "client_credentials", ...(scopes.length ? { scope: scopes.join(" ") } : {}) },
    { authorization: basicAuth(ctx.connector.clientId, secret) },
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
  ctx.tokenCache.set(cacheKey(ctx), token);
  return token;
};

export const oauth2ClientCredentialsStrategy: ConnectorStrategy = {
  kind: "oauth2_client_credentials",
  prepare: async (ctx) => {
    // Mint (and cache) a grant token now: validates the client credentials and
    // means the first use is warm. The handle expires with the token.
    const token = await resolveToken(ctx);
    const ttl = (ctx.connector.grantTtlSeconds ?? 300) + Math.floor(ctx.now() / 1000);
    return { expiresAt: token.expiresAt ? Math.min(ttl, token.expiresAt) : ttl };
  },
  inject: async (ctx) => {
    const token = await resolveToken(ctx);
    return { authorization: `${token.tokenType} ${token.value}`, ...(ctx.connector.staticHeaders ?? {}) };
  },
  token: resolveToken,
};
