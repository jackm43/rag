import { createRemoteJWKSet, customFetch, type FetchImplementation } from "jose";

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

const cache = new Map<string, RemoteJwks>();

export const remoteJwks = (url: string, fetchImpl?: FetchImplementation): RemoteJwks => {
  const cacheKey = fetchImpl ? `${url}\0bound` : url;
  let jwks = cache.get(cacheKey);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(url),
      fetchImpl ? { [customFetch]: fetchImpl } : undefined,
    );
    cache.set(cacheKey, jwks);
  }
  return jwks;
};
