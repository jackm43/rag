import { createContextKey } from "@connectrpc/connect";

export type IdentityKind = "user" | "service" | "platform";

export type Identity = {
  kind: IdentityKind;
  subject: string;
  email: string | null;
  scopes: string[];
  actorChain: string[];
  cnfJkt?: string | null;
  sessionId?: string | null;
};

export const identityKey = createContextKey<Identity | null>(null);

export const scopeMatches = (granted: string, required: string): boolean => {
  if (granted === "*" || granted === required) {
    return true;
  }
  if (granted.endsWith("/*")) {
    return required.startsWith(granted.slice(0, -1));
  }
  if (granted.endsWith(".*")) {
    return required.startsWith(granted.slice(0, -1));
  }
  return false;
};

export const hasScope = (identity: Identity, required: string): boolean =>
  identity.scopes.some((granted) => scopeMatches(granted, required));
