import {
  calculateJwkThumbprint,
  EmbeddedJWK,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWK,
} from "jose";

export const DPOP_HEADER = "dpop";
export const DPOP_ALGORITHM = "ES256";

const MAX_PROOF_AGE_SECONDS = 300;

export type RequestDescriptor = {
  method: string;
  url: string;
};

export type DpopProof = {
  jkt: string;
  jti: string;
  ath?: string;
};

export type DpopKey = {
  privateKey: CryptoKey;
  publicJwk: JWK;
};

const normalizeHtu = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
};

const b64urlDigest = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const verifyDpopProof = async (
  headers: Headers,
  request: RequestDescriptor,
  accessToken?: string,
): Promise<DpopProof | null> => {
  const proof = headers.get(DPOP_HEADER);
  if (!proof) {
    return null;
  }
  try {
    const { payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, {
      typ: "dpop+jwt",
      algorithms: [DPOP_ALGORITHM],
    });
    const jwk = protectedHeader.jwk as JWK | undefined;
    if (!jwk || "d" in jwk) {
      return null;
    }
    if (typeof payload.htm !== "string" || payload.htm.toUpperCase() !== request.method.toUpperCase()) {
      return null;
    }
    if (typeof payload.htu !== "string" || normalizeHtu(payload.htu) !== normalizeHtu(request.url)) {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.iat !== "number" || Math.abs(now - payload.iat) > MAX_PROOF_AGE_SECONDS) {
      return null;
    }
    if (typeof payload.jti !== "string" || payload.jti.length === 0) {
      return null;
    }
    if (accessToken) {
      if (typeof payload.ath !== "string" || payload.ath !== await b64urlDigest(accessToken)) {
        return null;
      }
    }
    return {
      jkt: await calculateJwkThumbprint(jwk, "sha256"),
      jti: payload.jti,
      ath: typeof payload.ath === "string" ? payload.ath : undefined,
    };
  } catch {
    return null;
  }
};

export const generateDpopKey = async (): Promise<DpopKey> => {
  const { privateKey, publicKey } = await generateKeyPair(DPOP_ALGORITHM, { extractable: false });
  return { privateKey, publicJwk: await exportJWK(publicKey) };
};

export const dpopThumbprint = (key: DpopKey): Promise<string> =>
  calculateJwkThumbprint(key.publicJwk, "sha256");

export const createDpopProof = async (
  key: DpopKey,
  request: RequestDescriptor,
  accessToken?: string,
): Promise<string> =>
  new SignJWT({
    htm: request.method.toUpperCase(),
    htu: normalizeHtu(request.url) ?? request.url,
    jti: crypto.randomUUID(),
    ...(accessToken ? { ath: await b64urlDigest(accessToken) } : {}),
  })
    .setProtectedHeader({ alg: DPOP_ALGORITHM, typ: "dpop+jwt", jwk: key.publicJwk })
    .setIssuedAt()
    .sign(key.privateKey);
