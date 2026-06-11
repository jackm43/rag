import { jwtVerify } from "jose";

import type { Identity, IdentityKind } from "../identity";
import { remoteJwks } from "./jwks";

export const TOKEN_TYPE_ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";
export const TOKEN_TYPE_JWT = "urn:ietf:params:oauth:token-type:jwt";
export const TOKEN_TYPE_SERVICE_CREDENTIAL = "urn:platy:params:oauth:token-type:service-credential";

export type StsVerifierConfig = {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  jwksFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

type ActClaim = { sub?: string; act?: ActClaim };

export const actorChainFromClaim = (act: unknown): string[] => {
  const chain: string[] = [];
  let current = act as ActClaim | undefined;
  while (current && typeof current === "object") {
    if (typeof current.sub === "string") {
      chain.push(current.sub);
    }
    current = current.act;
  }
  return chain;
};

export const stsJwksUrl = (issuer: string) => `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`;

export const verifyStsToken = async (
  token: string,
  config: StsVerifierConfig,
): Promise<Identity | null> => {
  try {
    const { payload } = await jwtVerify(
      token,
      remoteJwks(config.jwksUrl ?? stsJwksUrl(config.issuer), config.jwksFetch),
      {
        issuer: config.issuer,
        audience: config.audience,
      },
    );
    if (!payload.sub) {
      return null;
    }
    const kind: IdentityKind = payload.kind === "service" ? "service" : "user";
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
  } catch {
    return null;
  }
};
