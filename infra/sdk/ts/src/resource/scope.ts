import type { Identity } from "../identity";
import { INTERNAL_SESSION_SCOPE } from "../session-tier";

export const scopeMatches = (granted: string, required: string): boolean => {
  if (granted === required) {
    return true;
  }
  if (
    (granted === INTERNAL_SESSION_SCOPE || granted === "*") &&
    required.startsWith("idp/")
  ) {
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

export const defaultScope = (application: string, service: string, method: string): string =>
  `${application}/${service}.${method}`;
