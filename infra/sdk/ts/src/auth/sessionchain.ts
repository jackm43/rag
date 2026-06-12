import { requireSenderConstraint } from "../authz/constraints";
import { verifyMintedToken } from "../authz/minted";
import { ttlCache } from "../client/cache";
import { chainExchange, type ServiceCredential } from "../client/exchange";
import type { Identity } from "../identity";
import { verifyStsToken, type StsVerifierConfig } from "../verify/sts";
import { bearerToken, type Authenticator } from "./authenticators";

export type SessionChainConfig = {
  // Gateway issuer base URL (also the exchange endpoint host).
  gatewayUrl: string;
  // This application's audience (the chained token is minted for it).
  audience: string;
  // This application's service credential (worker secrets); the client secret
  // never leaves the server side.
  credential: ServiceCredential;
  // Verifier overrides (jwksUrl / gatewayFetch via a service binding).
  verify?: Partial<StsVerifierConfig>;
  // Transport for the exchange call; workers must pass their gateway service
  // binding's fetch (same-account workers.dev subrequests are blocked).
  fetch?: typeof fetch;
};

// sessionChainAuthenticator lets a browser stay a "dumb" public client: it
// sends only its DPoP-bound gateway *session* token (aud "idp") plus a fresh
// DPoP proof for this exact request. The application verifies the sender
// constraint at its edge, then completes a client-credentials chained exchange
// at the gateway (subject = the user's session, actor = this app's service
// credential) and authorizes against the resulting audience token — no
// redirects, no audience logic, and no client secret in the browser. The
// minted token carries the actor chain, so audit still names this app.
export const sessionChainAuthenticator = (config: SessionChainConfig): Authenticator => {
  const issuer = config.gatewayUrl.replace(/\/$/, "");
  const exchanged = ttlCache<Identity>();

  return async (headers, request) => {
    const token = bearerToken(headers);
    if (!token) {
      return null;
    }
    // Only handle DPoP-bound session tokens addressed to the gateway itself;
    // ordinary audience tokens are someone else's job (compose with
    // stsAuthenticator via anyAuthenticator).
    const session = await verifyStsToken(token, {
      issuer,
      audience: "idp",
      ...config.verify,
    });
    if (!session?.cnfJkt) {
      return null;
    }
    const constrained = await requireSenderConstraint(session, headers, request);
    if (!constrained) {
      return null;
    }

    const cached = exchanged.get(token);
    if (cached) {
      return cached;
    }

    const minted = await chainExchange(
      issuer,
      token,
      config.credential,
      config.audience,
      undefined,
      config.fetch,
    );
    if (!minted) {
      return null;
    }
    const verified = await verifyMintedToken(
      minted.accessToken,
      { issuer, audience: config.audience, ...config.verify },
      session.subject,
    );
    if (!verified) {
      return null;
    }
    // The original session token (not the minted audience token) is the right
    // subject for any further chained exchange this application makes.
    const identity = { ...verified, subjectToken: token };
    exchanged.set(token, identity, minted.expiresIn);
    return identity;
  };
};
