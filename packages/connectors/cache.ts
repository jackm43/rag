import type { ResolvedToken } from "./types";

// Per-isolate access-token cache. github_app installation tokens and
// oauth2_client_credentials grant tokens are cached until shortly before their
// provider-stated expiry so repeated uses do not re-hit the token endpoint. This
// is a pure optimisation on top of the shared grant store: a cache miss (cold
// isolate) simply re-mints, and nothing here is a source of truth. It is NOT a
// secret store in its own right — entries live only in memory and never persist.

const EXPIRY_SKEW_MS = 30_000;

export type AccessTokenCache = {
  // Returns a cached token still valid past the skew window, or null.
  get: (key: string) => ResolvedToken | null;
  set: (key: string, token: ResolvedToken) => void;
};

export const createAccessTokenCache = (now: () => number = Date.now): AccessTokenCache => {
  const entries = new Map<string, ResolvedToken>();
  return {
    get: (key) => {
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      // No stated expiry is treated as not cacheable across the skew window.
      if (entry.expiresAt === undefined || entry.expiresAt * 1000 - EXPIRY_SKEW_MS <= now()) {
        entries.delete(key);
        return null;
      }
      return entry;
    },
    set: (key, token) => {
      if (token.expiresAt !== undefined) {
        entries.set(key, token);
      }
    },
  };
};

// One cache per isolate, shared across requests. The handler reaches for this so
// warm isolates reuse installation/grant tokens without re-minting.
let shared: AccessTokenCache | null = null;
export const sharedAccessTokenCache = (): AccessTokenCache => (shared ??= createAccessTokenCache());
