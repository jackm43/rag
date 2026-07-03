import { assert, test } from "vitest";

import {
  verifyAccessJwt,
  type AccessKeyResolver,
} from "../../../../packages/boundaries/inbound/cf-access.ts";

// Focused crypto tests: the Access verifier is a security gate, so each way it
// must fail closed is proven, not assumed. Tokens are signed here with real
// WebCrypto keys (RS256 and ES256) and verified through an injected resolver,
// so no network or JWKS cache is involved.

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlJson = (value: unknown): string => b64url(encoder.encode(JSON.stringify(value)));

const ISS = "https://team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = 1_800_000_000;

const rsaKeys = async () =>
  crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );

const ecKeys = async () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

const signJwt = async (
  privateKey: CryptoKey,
  alg: "RS256" | "ES256",
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> => {
  const signingInput = `${b64urlJson({ alg, kid, typ: "JWT" })}.${b64urlJson(claims)}`;
  const params = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  const signature = await crypto.subtle.sign(params, privateKey, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
};

const resolverFor = (publicKey: CryptoKey, kid = "k1"): AccessKeyResolver => (candidate) =>
  candidate === kid ? publicKey : null;

const validClaims = () => ({ iss: ISS, aud: [AUD], sub: "user-abc", email: "dev@example.com", iat: NOW - 10, exp: NOW + 600 });
const options = { expectedIss: ISS, expectedAud: AUD, now: NOW };

test("a well-formed RS256 Access token verifies to its identity", async () => {
  const keys = await rsaKeys();
  const token = await signJwt(keys.privateKey, "RS256", "k1", validClaims());
  const result = await verifyAccessJwt(token, options, resolverFor(keys.publicKey));
  assert.deepEqual(result, { ok: true, identity: { sub: "user-abc", email: "dev@example.com" } });
});

test("a well-formed ES256 Access token verifies", async () => {
  const keys = await ecKeys();
  const token = await signJwt(keys.privateKey, "ES256", "k1", validClaims());
  const result = await verifyAccessJwt(token, options, resolverFor(keys.publicKey));
  assert.equal(result.ok, true);
});

test("a tampered payload is rejected as a bad signature", async () => {
  const keys = await rsaKeys();
  const token = await signJwt(keys.privateKey, "RS256", "k1", validClaims());
  const [header, , signature] = token.split(".");
  const forged = `${header}.${b64urlJson({ ...validClaims(), sub: "attacker" })}.${signature}`;
  const result = await verifyAccessJwt(forged, options, resolverFor(keys.publicKey));
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("a token for another Access application (aud) is rejected", async () => {
  const keys = await rsaKeys();
  const token = await signJwt(keys.privateKey, "RS256", "k1", { ...validClaims(), aud: ["other-aud"] });
  const result = await verifyAccessJwt(token, options, resolverFor(keys.publicKey));
  assert.deepEqual(result, { ok: false, reason: "aud_mismatch" });
});

test("a token from another issuer is rejected", async () => {
  const keys = await rsaKeys();
  const token = await signJwt(keys.privateKey, "RS256", "k1", { ...validClaims(), iss: "https://evil.example" });
  const result = await verifyAccessJwt(token, options, resolverFor(keys.publicKey));
  assert.deepEqual(result, { ok: false, reason: "iss_mismatch" });
});

test("an expired token is rejected", async () => {
  const keys = await rsaKeys();
  const token = await signJwt(keys.privateKey, "RS256", "k1", { ...validClaims(), exp: NOW - 3600 });
  const result = await verifyAccessJwt(token, options, resolverFor(keys.publicKey));
  assert.deepEqual(result, { ok: false, reason: "expired" });
});

test("an unknown key id is rejected before any signature check", async () => {
  const keys = await rsaKeys();
  const token = await signJwt(keys.privateKey, "RS256", "unknown-kid", validClaims());
  const result = await verifyAccessJwt(token, options, resolverFor(keys.publicKey, "k1"));
  assert.deepEqual(result, { ok: false, reason: "unknown_kid" });
});

test("an unsupported algorithm (alg=none / HS256) is rejected", async () => {
  const keys = await rsaKeys();
  const none = `${b64urlJson({ alg: "none", kid: "k1" })}.${b64urlJson(validClaims())}.`;
  const hs = `${b64urlJson({ alg: "HS256", kid: "k1" })}.${b64urlJson(validClaims())}.AAAA`;
  assert.deepEqual(await verifyAccessJwt(none, options, resolverFor(keys.publicKey)), {
    ok: false,
    reason: "unsupported_alg",
  });
  assert.deepEqual(await verifyAccessJwt(hs, options, resolverFor(keys.publicKey)), {
    ok: false,
    reason: "unsupported_alg",
  });
});

test("a non-string or malformed token is rejected without throwing", async () => {
  const keys = await rsaKeys();
  for (const bad of [undefined, "", "a.b", "not-a-jwt"]) {
    const result = await verifyAccessJwt(bad, options, resolverFor(keys.publicKey));
    assert.equal(result.ok, false);
  }
});
