import { requireExpectedActorChain, requireSenderConstraint } from "../resource/constraints";
import type { Identity } from "../identity";
import type { RequestDescriptor } from "../oauth2/dpop";
import { verifyOidcToken, type OidcProviderConfig } from "../oauth2/oidc";
import { verifyStsToken, type StsVerifierConfig } from "../oauth2/sts";

export type Authenticator = (
  headers: Headers,
  request?: RequestDescriptor,
) => Promise<Identity | null>;

export const bearerToken = (headers: Headers): string | null => {
  const header = headers.get("authorization") ?? "";
  const match = /^bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
};

export const stsAuthenticator =
  (config: StsVerifierConfig): Authenticator =>
    async (headers, request) => {
      const token = bearerToken(headers);
      if (!token) {
        return null;
      }
      const identity = await requireExpectedActorChain(await verifyStsToken(token, config), config);
      const constrained = await requireSenderConstraint(identity, headers, request);
      return constrained ? { ...constrained, subjectToken: token } : null;
    };

export const oidcAuthenticator =
  (provider: OidcProviderConfig): Authenticator =>
    async (headers) => {
      const token = bearerToken(headers);
      if (!token) {
        return null;
      }
      return verifyOidcToken(token, provider);
    };

export const anyAuthenticator =
  (...authenticators: Authenticator[]): Authenticator =>
    async (headers, request) => {
      for (const authenticate of authenticators) {
        const identity = await authenticate(headers, request);
        if (identity) {
          return identity;
        }
      }
      return null;
    };
