import { createLocalJWKSet, jwtVerify } from "jose";

import { actorChainFromClaim, verifyStsToken, type Identity } from "../../../../sdk/ts/src";
import { getJwks } from "./keys";
import type { Env } from "./types";

const issuer = (env: Env) => env.GATEWAY_ISSUER.replace(/\/$/, "");
const jwksUrl = (env: Env) => `${issuer(env)}/.well-known/jwks.json`;

let localJwks: ReturnType<typeof createLocalJWKSet> | null = null;
let localJwksLoadedAt = 0;

const localSigningJwks = async (env: Env): Promise<ReturnType<typeof createLocalJWKSet> | null> => {
  const now = Date.now();
  if (!localJwks || now - localJwksLoadedAt > 60_000) {
    const response = await getJwks(env);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { keys: Record<string, unknown>[] };
    localJwks = createLocalJWKSet(body);
    localJwksLoadedAt = now;
  }
  return localJwks;
};

const identityFromStsPayload = (payload: Record<string, unknown>): Identity | null => {
  if (typeof payload.sub !== "string") {
    return null;
  }
  const kind = payload.kind === "service" ? "service" : "user";
  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
  const cnf = payload.cnf as { jkt?: unknown } | undefined;
  return {
    kind,
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    scopes,
    actorChain: actorChainFromClaim(payload.act),
    cnfJkt: typeof cnf?.jkt === "string" ? cnf.jkt : null,
    sessionId: typeof payload.sid === "string" ? payload.sid : null,
  };
};

export const verifyGatewayStsToken = async (
  env: Env,
  token: string,
  audience: string,
): Promise<Identity | null> => {
  const jwks = await localSigningJwks(env);
  if (jwks) {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: issuer(env),
        audience,
      });
      return identityFromStsPayload(payload as Record<string, unknown>);
    } catch {
      // Fall through to remote JWKS verification.
    }
  }
  return verifyStsToken(token, {
    issuer: issuer(env),
    audience,
    jwksUrl: jwksUrl(env),
  });
};
