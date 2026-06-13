import { serviceCredentialFromEnv } from "../oauth2/credential";
import { anyAuthenticator, stsAuthenticator, type Authenticator } from "./authenticators";
import { sessionChainAuthenticator } from "./sessionchain";

export type PlatformAuthEnv = {
  AUTH_GATEWAY_URL?: string;
  AUTH_GATEWAY?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string;
};

// platformAuthenticator builds the standard inbound authenticator for an RPC
// worker straight from its environment: an audience-scoped STS verifier plus,
// when the worker carries a service credential, the browser session-chaining
// path for BFF callers. Workers no longer hand-wire the issuer, JWKS URL,
// gateway service-binding fetch, or the credential plumbing.
export const platformAuthenticator = (env: PlatformAuthEnv, audience: string): Authenticator => {
  const issuer = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
  const gatewayFetch = env.AUTH_GATEWAY
    ? (input: RequestInfo | URL, init?: RequestInit) => env.AUTH_GATEWAY!.fetch(input, init)
    : undefined;
  const credential = serviceCredentialFromEnv(env);
  const verify = {
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    gatewayFetch,
    serviceCredential: credential ?? undefined,
  };
  const authenticators: Authenticator[] = [stsAuthenticator({ issuer, audience, ...verify })];
  if (credential) {
    authenticators.push(
      sessionChainAuthenticator({ gatewayUrl: issuer, audience, credential, verify, fetch: gatewayFetch }),
    );
  }
  return anyAuthenticator(...authenticators);
};
