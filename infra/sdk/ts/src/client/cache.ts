// Shared TTL cache for short-lived per-caller artifacts (minted tokens,
// exchanged identities). Entries expire 15 seconds before their lifetime so a
// token is never attached right at its expiry; stale entries are swept when
// the cache grows past its bound.
const EXPIRY_SKEW_SECONDS = 15;

export type TtlCache<T> = {
  get(key: string): T | null;
  set(key: string, value: T, expiresIn: number): void;
};

export const ttlCache = <T>(maxEntries = 256): TtlCache<T> => {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  return {
    get(key) {
      const now = Math.floor(Date.now() / 1000);
      const entry = entries.get(key);
      return entry && now < entry.expiresAt - EXPIRY_SKEW_SECONDS ? entry.value : null;
    },
    set(key, value, expiresIn) {
      const now = Math.floor(Date.now() / 1000);
      entries.set(key, { value, expiresAt: now + expiresIn });
      if (entries.size > maxEntries) {
        for (const [cachedKey, entry] of entries) {
          if (entry.expiresAt - EXPIRY_SKEW_SECONDS <= now) {
            entries.delete(cachedKey);
          }
        }
      }
    },
  };
};
