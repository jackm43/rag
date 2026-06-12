import type { Identity } from "../identity";
import { verifyDpopProof, type RequestDescriptor } from "../verify/dpop";
import { verifyOidcToken, type OidcProviderConfig } from "../verify/oidc";
import { verifyStsToken, type StsVerifierConfig } from "../verify/sts";

export type Authenticator = (
  headers: Headers,
  request?: RequestDescriptor,
) => Promise<Identity | null>;

export const bearerToken = (headers: Headers): string | null => {
  const header = headers.get("authorization") ?? "";
  const match = /^bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
};

// A cnf-bound identity is only valid when the caller proves possession of
// the bound key with a fresh DPoP proof for this exact request.
export const requireSenderConstraint = async (
  identity: Identity | null,
  headers: Headers,
  request?: RequestDescriptor,
): Promise<Identity | null> => {
  if (!identity || !identity.cnfJkt) {
    return identity;
  }
  if (!request) {
    return null;
  }
  const proof = await verifyDpopProof(headers, request);
  if (!proof || proof.jkt !== identity.cnfJkt) {
    return null;
  }
  return identity;
};

export const stsAuthenticator =
  (config: StsVerifierConfig): Authenticator =>
    async (headers, request) => {
      const token = bearerToken(headers);
      if (!token) {
        return null;
      }
      const identity = await verifyStsToken(token, config);
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
