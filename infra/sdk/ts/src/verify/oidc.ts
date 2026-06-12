import { jwtVerify } from "jose";

import type { Identity } from "../identity";
import { remoteJwks } from "./jwks";

export type OidcProviderConfig = {
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
};

export const accessOidcProvider = (teamDomain: string, clientId: string): OidcProviderConfig => {
  const team = teamDomain.replace(/\/$/, "");
  const base = `${team}/cdn-cgi/access/sso/oidc/${clientId}`;
  return {
    issuer: base,
    clientId,
    authorizationEndpoint: `${base}/authorization`,
    tokenEndpoint: `${base}/token`,
    jwksEndpoint: `${base}/jwks`,
  };
};

const boundOidcClient = (payload: { aud?: unknown; client_id?: unknown }): string | null => {
  if (typeof payload.client_id === "string" && payload.client_id.length > 0) {
    return payload.client_id;
  }
  if (typeof payload.aud === "string") {
    return payload.aud;
  }
  if (Array.isArray(payload.aud) && typeof payload.aud[0] === "string") {
    return payload.aud[0];
  }
  return null;
};

export const verifyOidcToken = async (
  token: string,
  provider: OidcProviderConfig,
): Promise<Identity | null> => {
  try {
    const { payload } = await jwtVerify(token, remoteJwks(provider.jwksEndpoint), {
      issuer: provider.issuer,
    });
    if (!payload.sub) {
      return null;
    }
    if (boundOidcClient(payload) !== provider.clientId) {
      return null;
    }
    return {
      kind: "user",
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      // An upstream OIDC token authenticates the user to the gateway only.
      // It is not a grant for application audiences: sessions and exchanged
      // STS tokens carry those scopes.
      scopes: ["idp/*"],
      actorChain: [],
    };
  } catch {
    return null;
  }
};
