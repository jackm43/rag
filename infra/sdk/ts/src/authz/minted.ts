import type { Identity } from "../identity";
import { logger } from "../logger";
import { verifyStsToken, type StsVerifierConfig } from "../verify/sts";
import { requireExpectedActorChain } from "./constraints";

// verifyMintedToken is the receiver-side check applied to every token this
// process obtains from a chained exchange before the token is trusted or
// cached: full signature/issuer/audience verification against the gateway
// JWKS plus the actor-chain delegation re-check, and optionally that the
// minted token still names the expected caller as subject. Returns null on
// any failure so callers fail closed; the unverified token must never be
// used as a fallback.
export const verifyMintedToken = async (
  token: string,
  config: StsVerifierConfig,
  expectedSubject?: string,
): Promise<Identity | null> => {
  const identity = await requireExpectedActorChain(await verifyStsToken(token, config), config);
  if (!identity) {
    logger.warn("minted_token_rejected", { audience: config.audience });
    return null;
  }
  if (expectedSubject && identity.subject !== expectedSubject) {
    logger.warn("minted_token_rejected", {
      audience: config.audience,
      reason: "subject mismatch",
    });
    return null;
  }
  return identity;
};
