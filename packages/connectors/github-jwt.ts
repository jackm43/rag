// GitHub App authentication crypto. A GitHub App authenticates to the REST API
// in two steps: it signs a short-lived App JWT (RS256) with its private key, then
// exchanges that JWT for an installation access token scoped to one installation.
// This module owns only the first, security-critical half: importing the App's
// RSA private key and minting the App JWT with WebCrypto. The installation-token
// exchange is an ordinary boundary-client call in the github_app strategy.
//
// The App JWT is deliberately tiny and short-lived: iss = App id, iat backdated
// 60s for clock skew, exp 9 minutes out (GitHub rejects anything over 10). It is
// never persisted — it exists only long enough to obtain an installation token.

const encoder = new TextEncoder();

const RSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const buf = (view: Uint8Array): BufferSource => view as unknown as BufferSource;

const b64urlFromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlJson = (value: unknown): string =>
  b64urlFromBytes(encoder.encode(JSON.stringify(value)));

// Decode a base64 (standard, not url) blob to bytes — PEM bodies are standard.
const bytesFromBase64 = (value: string): Uint8Array => {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

// Minimal DER length prefix (short form up to 127, else long form).
const derLength = (length: number): number[] => {
  if (length < 0x80) {
    return [length];
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
};

const derWrap = (tag: number, contents: Uint8Array): Uint8Array => {
  const length = derLength(contents.length);
  const out = new Uint8Array(1 + length.length + contents.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(contents, 1 + length.length);
  return out;
};

// AlgorithmIdentifier for rsaEncryption: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }.
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

// Wrap a PKCS#1 RSAPrivateKey DER into a PKCS#8 PrivateKeyInfo, since WebCrypto
// only imports PKCS#8. GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`) by
// default, so this lets an operator paste the key GitHub gives them verbatim.
//   PrivateKeyInfo ::= SEQUENCE { version INTEGER 0, algorithm, privateKey OCTET STRING }
const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array => {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privateKey = derWrap(0x04, pkcs1);
  const body = new Uint8Array(version.length + RSA_ALGORITHM_IDENTIFIER.length + privateKey.length);
  body.set(version, 0);
  body.set(RSA_ALGORITHM_IDENTIFIER, version.length);
  body.set(privateKey, version.length + RSA_ALGORITHM_IDENTIFIER.length);
  return derWrap(0x30, body);
};

// Import an RSA private key from a PEM string, accepting both PKCS#8
// (`BEGIN PRIVATE KEY`) and PKCS#1 (`BEGIN RSA PRIVATE KEY`).
export const importAppPrivateKey = async (pem: string): Promise<CryptoKey> => {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, "")
    .trim();
  const der = bytesFromBase64(body);
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey("pkcs8", buf(pkcs8), RSA_SHA256, false, ["sign"]);
};

export const APP_JWT_TTL_SECONDS = 540;
const APP_JWT_BACKDATE_SECONDS = 60;

// Mint the App JWT: signs {iat, exp, iss} with RS256. `nowSeconds` is injectable
// for tests. Returns a compact JWS (header.payload.signature).
export const mintAppJwt = async (
  privateKey: CryptoKey,
  appId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> => {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - APP_JWT_BACKDATE_SECONDS,
    exp: nowSeconds + APP_JWT_TTL_SECONDS,
    iss: appId,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = await crypto.subtle.sign(RSA_SHA256, privateKey, buf(encoder.encode(signingInput)));
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`;
};
