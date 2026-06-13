import { loadServiceCredentialFromEnv, type ServiceCredentialEnv } from "../oauth2/credential";
import { anyAuthenticator, stsAuthenticator, type Authenticator } from "./authenticators";
import { sessionChainAuthenticator } from "./sessionchain";

export type PlatformAuthEnv = ServiceCredentialEnv & {
  AUTH_GATEWAY_URL?: string;
  AUTH_GATEWAY?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};

export const platformAuthenticator = (env: PlatformAuthEnv, audience: string): Authenticator => {
  const issuer = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
  const gatewayFetch = env.AUTH_GATEWAY
    ? (input: RequestInfo | URL, init?: RequestInit) => env.AUTH_GATEWAY!.fetch(input, init)
    : undefined;
  const verify = {
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    gatewayFetch,
  };
  let credentialPromise: ReturnType<typeof loadServiceCredentialFromEnv> | null = null;
  const credential = async () => {
    credentialPromise ??= loadServiceCredentialFromEnv(env);
    return credentialPromise;
  };
  const authenticators: Authenticator[] = [
    stsAuthenticator({ issuer, audience, ...verify }),
    async (headers, request) => {
      const resolved = await credential();
      if (!resolved) {
        return null;
      }
      return sessionChainAuthenticator({
        gatewayUrl: issuer,
        audience,
        credential: resolved,
        verify,
        fetch: gatewayFetch,
      })(headers, request);
    },
  ];
  return anyAuthenticator(...authenticators);
};
