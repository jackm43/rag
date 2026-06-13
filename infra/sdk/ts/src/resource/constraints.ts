import type { Identity } from "../identity";
import { logger } from "../logger";
import { verifyDpopProof, type RequestDescriptor } from "../oauth2/dpop";
import type { StsVerifierConfig } from "../oauth2/sts";
import { principalFromIdentity } from "../identity";
import { actorChainRefusal, delegationGraph } from "./delegations";

const bearerToken = (headers: Headers): string | undefined => {
  const match = /^bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "");
  return match?.[1]?.trim();
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
  const proof = await verifyDpopProof(headers, request, bearerToken(headers));
  if (!proof || proof.jkt !== identity.cnfJkt) {
    return null;
  }
  return identity;
};

// A chained identity is only accepted when its full actor chain is an
// expected, currently-delegated path in the gateway's registry (published in
// discovery). The gateway enforced this at mint time; the receiver
// re-validates so a revoked delegation or unknown actor fails closed at the
// boundary too.
export const requireExpectedActorChain = async (
  identity: Identity | null,
  config: StsVerifierConfig,
): Promise<Identity | null> => {
  if (!identity || identity.actorChain.length === 0) {
    return identity;
  }
  const graph = await delegationGraph({
    issuer: config.issuer,
    gatewayFetch: config.gatewayFetch,
    credential: config.serviceCredential,
  });
  const refusal = graph
    ? actorChainRefusal(identity, config.audience, graph)
    : "delegation graph unavailable";
  if (refusal) {
    logger.warn("actor_chain_rejected", {
      audience: config.audience,
      principal: principalFromIdentity(identity),
      reason: refusal,
    });
    return null;
  }
  return identity;
};
