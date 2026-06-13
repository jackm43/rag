export type SessionTier = "internal" | "community";

export const INTERNAL_SESSION_SCOPE = "internal";
export const COMMUNITY_SESSION_SCOPE = "community";

export const sessionScopeForTier = (tier: SessionTier): string => tier;

export const sessionTierFromScope = (scopes: string[]): SessionTier | null => {
  if (scopes.includes(INTERNAL_SESSION_SCOPE)) {
    return "internal";
  }
  if (scopes.includes(COMMUNITY_SESSION_SCOPE)) {
    return "community";
  }
  return null;
};

export const sessionTierFromIdentity = (identity: { scopes: string[] }): SessionTier | null =>
  sessionTierFromScope(identity.scopes);

export const isInternalSession = (identity: { scopes: string[] }): boolean =>
  sessionTierFromIdentity(identity) === "internal";

export const isCommunitySession = (identity: { scopes: string[] }): boolean =>
  sessionTierFromIdentity(identity) === "community";

export const directExchangeGrants = (
  identity: { scopes: string[] },
  audience: string,
): string[] | null => {
  const tier = sessionTierFromIdentity(identity);
  if (tier === "internal") {
    return [`${audience}/*`];
  }
  if (tier === "community") {
    return null;
  }
  return identity.scopes;
};

export const communitySessionRequiresActor = (identity: { scopes: string[] }): boolean =>
  isCommunitySession(identity);
