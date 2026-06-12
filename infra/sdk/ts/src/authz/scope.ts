import type { Identity } from "../identity";

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
