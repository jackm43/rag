import { createRemoteJWKSet, jwtVerify } from "jose";

import { errorMessage, logger } from "./logger";
import type { Env } from "./types";

export type AccessIdentity = {
  sub: string;
  email: string | null;
};

export type OidcConfig = {
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
};

// The admin API is an OIDC resource of the Cloudflare Access for SaaS
// application; Access issues and signs all tokens with per-application keys.
export const getOidcConfig = (env: Env): OidcConfig | null => {
  const issuer = env.ACCESS_TEAM_DOMAIN;
  const clientId = env.ACCESS_OIDC_CLIENT_ID;
  if (!issuer || !clientId) {
    return null;
  }
  const base = `${issuer}/cdn-cgi/access/sso/oidc/${clientId}`;
  return {
    issuer,
    clientId,
    authorizationEndpoint: `${base}/authorization`,
    tokenEndpoint: `${base}/token`,
    jwksEndpoint: `${base}/jwks`,
  };
};

let jwksCache: { url: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

const getJwks = (url: string) => {
  if (jwksCache?.url !== url) {
    jwksCache = { url, jwks: createRemoteJWKSet(new URL(url)) };
  }
  return jwksCache.jwks;
};

// Validates an Access-issued OIDC JWT against the application JWKS, so the
// admin API fails closed regardless of how the request reached the worker.
export const verifyOidcToken = async (token: string, env: Env): Promise<AccessIdentity | null> => {
  const config = getOidcConfig(env);
  if (!config) {
    logger.warn("oidc_auth_unconfigured");
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(config.jwksEndpoint), {
      issuer: config.issuer,
      audience: config.clientId,
    });
    if (!payload.sub) {
      return null;
    }
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
    };
  } catch (error) {
    logger.warn("oidc_token_rejected", { error: errorMessage(error) });
    return null;
  }
};
