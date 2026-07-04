import { assert, test } from "vitest";

import {
  APP_JWT_TTL_SECONDS,
  importAppPrivateKey,
  mintAppJwt,
} from "@rag/connectors/lib/providers/github";

// Security-critical crypto: the GitHub App JWT is what proves the broker holds
// the App private key. These tests prove the RS256 signature is real (verifiable
// by the matching public key), the claims are correct and short-lived, and that
// BOTH PKCS#8 and PKCS#1 private keys import — a test is the only way to prove the
// PKCS#1 -> PKCS#8 wrapping produces a key that actually signs.

// Throwaway RSA-2048 keypair generated only for this test (never a real App key).
const PKCS1_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAo6ZO6+S+oJqKOgltJGvUQ7e0QNH3eMLKXEx4+/a9xFEg/b9w
z8gjyNxqBS4Qzt3T4l2bd+sMkslE2rSBxpePANtrHGrzWK5JvsoCkgDF58xpZ1rt
Pmm6NgteGCnAhTwbZksnTJaaPH0sijdQWQIlx6ctJ9bbdwU7vZfgVSO7cV5QO5dW
ZQpcF/VE2Sr2DFI6uiixUD8ZY478Jve0I1q6YuDfzWzwHjqxpaQslecz4UgvdSQk
9nInClmrjBq2E8ycyRNxwWqGoV8238VygLyDEo5uBiU3Qe0uqnHj2NZoJsqWjsKs
v5qjSzWMIRZNvd1NmWT7W2paW92WchtPZLFBBQIDAQABAoIBAAY1pYl8ZsJT0tpk
aKyI3edK5W9POEdwBrstWKrg4C7+kBSoyrhLpRX2TRyQtKkQ0D0m5aMNe27nbbIp
xsHZFt9GtCACK+UpydkQM7xEBL5oqng2QknLu7nYwROEJA66KuT9BYr5rPUOH95H
vof+FZ5niMZZ9/5iZ7OoO2YnorFovfFqaZX2nLketNTSZyOBqUewKxn9/0dnKzRv
F4wERl9MiLaYLZsn77l8vMnpZ4kZxyyDDN/UsTm99mxjT7FQPVoY7H5+msLpupCt
nTeoqNivZ7fp2I9xFABQ2kfN3hKjXJfo7yGSpQhXK1B/TNAo7j+S9iQYPvgLAlTf
UDAq5ykCgYEA1ReQw/oPolumsU/c9AUEkYHRGU477mj3zfE8y7Vcgh3pS/vpzc6g
pq7i0hwikTGBlVO8NYcDwferWfr6xC92ORcu+IPLXfE0t0/Kjl6zgp1LKbUJJoiW
vJcaEdj0e1JbljQQff/gLBSixfv78TvRCklpoCII3TvnG4CoCuGyQF0CgYEAxJoX
6wqGU4nElS45p4x1V8EPKt510kaYdMtUvIMdgD8b3U7v2YUNRultgGVQQsrRddaK
nSsRiDW9gwWb/G5X0EsmbTRYsSqe7plNzIEraStzWjYhmfJUXei9FUi6H6IF0ZAy
/TSlbZ1yWx2nQw8O7FlASDL77SbCbazmOdVEGMkCgYBK5qmf+TmdnBGPqb7Ely7v
5m2VM4alWogf/3ebMvh9U/45EycvjD2z2S0pJXKRDpG552D0f6y2dVPpoOqcIwKv
NpLwD4NgVfRtqsJMIMWAV8Gfu16oCMLTL1mehGALKPvAZDSX1WT6mZZNeTEprhjg
QMW737q16ORnKmXmzUZWkQKBgQCmjJ/chsL6vAgkFM/Ux6GUoMFXoLORWirHLoVv
WWfBgDT7y2ZXEGcJ/q+8CJfwrV66g/BTauvkRxpvh234cAXGOBOqiaDlHWUcXhTR
PU/oPV3wO1FF2Etubr7X7A94wspJGO6JIHNQJAR/eeR7Y6NRx940C7Tt11r4jHNQ
5QFWOQKBgFbkIEdPI1Xnq9eb7dsd3yn9l2+xM752rSjU/djLNBOkOVIEZjQXLRkA
5RMk+V3+h5ZLvr3kgsWmbXC8DEB5JNTkN37N6D4KF/acIKOfUtbINoK1zgyNF1w6
qhhkkLkLAwdN0kPoYSUiv+KB3SK9k3ggNbXrb6ohM3oyyZC6r9hH
-----END RSA PRIVATE KEY-----`;

const SPKI_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo6ZO6+S+oJqKOgltJGvU
Q7e0QNH3eMLKXEx4+/a9xFEg/b9wz8gjyNxqBS4Qzt3T4l2bd+sMkslE2rSBxpeP
ANtrHGrzWK5JvsoCkgDF58xpZ1rtPmm6NgteGCnAhTwbZksnTJaaPH0sijdQWQIl
x6ctJ9bbdwU7vZfgVSO7cV5QO5dWZQpcF/VE2Sr2DFI6uiixUD8ZY478Jve0I1q6
YuDfzWzwHjqxpaQslecz4UgvdSQk9nInClmrjBq2E8ycyRNxwWqGoV8238VygLyD
Eo5uBiU3Qe0uqnHj2NZoJsqWjsKsv5qjSzWMIRZNvd1NmWT7W2paW92WchtPZLFB
BQIDAQAB
-----END PUBLIC KEY-----`;

const encoder = new TextEncoder();

const derFromPem = (pem: string): Uint8Array => {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const bytesFromB64url = (value: string): Uint8Array => {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const jsonFromB64url = (value: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(bytesFromB64url(value)));

const importPublicKey = () =>
  crypto.subtle.importKey(
    "spki",
    derFromPem(SPKI_PUBLIC_KEY) as unknown as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

const verifyJwt = async (jwt: string): Promise<boolean> => {
  const [header, payload, signature] = jwt.split(".");
  return crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    await importPublicKey(),
    bytesFromB64url(signature) as unknown as BufferSource,
    encoder.encode(`${header}.${payload}`) as unknown as BufferSource,
  );
};

test("mints an RS256 App JWT with correct, short-lived claims, verifiable by the public key", async () => {
  const key = await importAppPrivateKey(PKCS1_PRIVATE_KEY);
  const jwt = await mintAppJwt(key, "123456", 1_000_000);

  const [encodedHeader, encodedPayload] = jwt.split(".");
  const header = jsonFromB64url(encodedHeader);
  const payload = jsonFromB64url(encodedPayload);

  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");
  assert.equal(payload.iss, "123456");
  // iat is backdated 60s for clock skew; exp is APP_JWT_TTL_SECONDS out.
  assert.equal(payload.iat, 1_000_000 - 60);
  assert.equal(payload.exp, 1_000_000 + APP_JWT_TTL_SECONDS);
  // exp is under GitHub's 10-minute ceiling relative to iat.
  assert.isBelow((payload.exp as number) - (payload.iat as number), 600 + 1);

  assert.isTrue(await verifyJwt(jwt), "signature must verify against the matching public key");
});

test("accepts a PKCS#8 private key as well as PKCS#1 (native import path)", async () => {
  // A freshly generated key, exported as PKCS#8, must import and sign verifiably
  // through the same path — the PKCS#1 fixture above covers the wrapping path.
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8)).replace(
    /(.{64})/g,
    "$1\n",
  )}\n-----END PRIVATE KEY-----`;

  const key = await importAppPrivateKey(pem);
  const jwt = await mintAppJwt(key, "654321", 2_000_000);
  const [header, payload, signature] = jwt.split(".");
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    pair.publicKey,
    bytesFromB64url(signature) as unknown as BufferSource,
    encoder.encode(`${header}.${payload}`) as unknown as BufferSource,
  );
  assert.isTrue(valid);
});
