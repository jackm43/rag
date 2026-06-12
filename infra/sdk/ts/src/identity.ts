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
  // The bearer token the caller presented, usable as the subject of a further
  // chained exchange (the gateway accepts the actor's own audience and "idp"
  // session tokens as chaining subjects). Set by the authenticators; absent
  // for identities that cannot chain onward.
  subjectToken?: string | null;
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
