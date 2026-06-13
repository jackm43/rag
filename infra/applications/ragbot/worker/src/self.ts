import {
  exchangeToken,
  serviceCredentialFromEnv,
  TOKEN_TYPE_SERVICE_CREDENTIAL,
  type Identity,
} from "@platy/sdk";
import type { Env } from "./types";

// Queue-driven channel chat has no caller to chain: the worker acts as itself
// by exchanging its service credential for a gateway-issued subject token for
// its own audience, which downstream connectors then chain like any caller.
export const selfIdentity = async (env: Env): Promise<Identity> => {
  const credential = serviceCredentialFromEnv(env);
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
    env.AUTH_GATEWAY ? (input, init) => env.AUTH_GATEWAY!.fetch(input, init) : undefined,
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
