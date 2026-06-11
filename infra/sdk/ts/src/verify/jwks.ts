import { createRemoteJWKSet } from "jose";

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

const cache = new Map<string, RemoteJwks>();

export const remoteJwks = (url: string): RemoteJwks => {
  let jwks = cache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    cache.set(url, jwks);
  }
  return jwks;
};
