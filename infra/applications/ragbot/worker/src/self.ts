import {
  exchangeToken,
  loadServiceCredentialFromEnv,
  serviceBindingFetch,
  TOKEN_TYPE_SERVICE_CREDENTIAL,
  type Identity,
} from "@platy/sdk";
import type { Env } from "./types";

export const selfIdentity = async (env: Env): Promise<Identity> => {
  const credential = await loadServiceCredentialFromEnv(env);
  if (!credential) {
    throw new Error("service credential not configured");
  }
  const gatewayUrl = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
  const minted = await exchangeToken(
    gatewayUrl,
    {
      subjectToken: `${credential.clientId}:${credential.clientSecret}`,
      subjectTokenType: TOKEN_TYPE_SERVICE_CREDENTIAL,
      audience: "ragbot",
    },
    serviceBindingFetch(env.AUTH_GATEWAY, "AUTH_GATEWAY"),
  );
  if (!minted) {
    throw new Error("self token exchange refused");
  }
  return {
    kind: "service",
    subject: credential.clientId,
    email: null,
    scopes: minted.scopes,
    actorChain: [],
    subjectToken: minted.accessToken,
  };
};
