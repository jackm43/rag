import { assert, test } from "vitest";

import {
  ecThumbprint,
  verifyDpopProof,
  type DpopReplayStore,
} from "../../../../packages/boundaries/inbound/dpop.ts";

// Focused crypto tests for the DPoP proof verifier: it sender-constrains and
// replay-protects every dev-proxy request, so each fail-closed branch is
// proven. Proofs are signed here with a real WebCrypto P-256 key.

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlJson = (value: unknown): string => b64url(encoder.encode(JSON.stringify(value)));

const HTU = "https://dev-proxy.example.com/api/command";
const HTM = "POST";
const NOW = 1_800_000_000;

// A replay store that records jtis in-memory; returns true on a second sighting.
const memoryStore = (): DpopReplayStore => {
  const seen = new Set<string>();
  return {
    seenBefore: async (jti) => {
      if (seen.has(jti)) {
        return true;
      }
      seen.add(jti);
      return false;
    },
  };
};

const publicJwk = async (keys: CryptoKeyPair) => {
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as { crv: string; x: string; y: string };
  return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
};

const signProof = async (
  keys: CryptoKeyPair,
  payload: Record<string, unknown>,
  header?: Record<string, unknown>,
): Promise<string> => {
  const jwk = await publicJwk(keys);
  const signingInput = `${b64urlJson({ typ: "dpop+jwt", alg: "ES256", jwk, ...header })}.${b64urlJson(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
};

const ecKeys = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const validPayload = (jti = "jti-1") => ({ htm: HTM, htu: HTU, jti, iat: NOW - 1 });
const options = { htm: HTM, htu: HTU, now: NOW };

test("a well-formed proof verifies and returns the key thumbprint", async () => {
  const keys = await ecKeys();
  const result = await verifyDpopProof(await signProof(keys, validPayload()), options, memoryStore());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.jkt, await ecThumbprint(await publicJwk(keys)));
    assert.equal(result.jti, "jti-1");
  }
});

test("a replayed jti is rejected on its second presentation", async () => {
  const keys = await ecKeys();
  const store = memoryStore();
  const proof = await signProof(keys, validPayload("replay-me"));
  assert.equal((await verifyDpopProof(proof, options, store)).ok, true);
  assert.deepEqual(await verifyDpopProof(proof, options, store), { ok: false, reason: "replayed" });
});

test("a proof bound to a different method is rejected", async () => {
  const keys = await ecKeys();
  const proof = await signProof(keys, { ...validPayload(), htm: "GET" });
  assert.deepEqual(await verifyDpopProof(proof, options, memoryStore()), { ok: false, reason: "htm_mismatch" });
});

test("a proof bound to a different URI is rejected", async () => {
  const keys = await ecKeys();
  const proof = await signProof(keys, { ...validPayload(), htu: "https://evil.example.com/api/command" });
  assert.deepEqual(await verifyDpopProof(proof, options, memoryStore()), { ok: false, reason: "htu_mismatch" });
});

test("query and fragment differences in htu do not matter", async () => {
  const keys = await ecKeys();
  const proof = await signProof(keys, { ...validPayload(), htu: `${HTU}?x=1#y` });
  assert.equal((await verifyDpopProof(proof, { ...options, htu: `${HTU}?other=2` }, memoryStore())).ok, true);
});

test("a stale (too old) proof is rejected", async () => {
  const keys = await ecKeys();
  const proof = await signProof(keys, { ...validPayload(), iat: NOW - 3600 });
  assert.deepEqual(await verifyDpopProof(proof, options, memoryStore()), { ok: false, reason: "stale" });
});

test("a future-dated proof is rejected", async () => {
  const keys = await ecKeys();
  const proof = await signProof(keys, { ...validPayload(), iat: NOW + 3600 });
  assert.deepEqual(await verifyDpopProof(proof, options, memoryStore()), { ok: false, reason: "stale" });
});

test("a tampered payload is rejected as a bad signature", async () => {
  const keys = await ecKeys();
  const proof = await signProof(keys, validPayload());
  const [header, , signature] = proof.split(".");
  const forged = `${header}.${b64urlJson({ ...validPayload(), htu: "https://evil.example.com/api/command" })}.${signature}`;
  assert.deepEqual(await verifyDpopProof(forged, options, memoryStore()), { ok: false, reason: "bad_signature" });
});

test("a proof carrying a private key component is rejected", async () => {
  const keys = await ecKeys();
  const privateJwk = (await crypto.subtle.exportKey("jwk", keys.privateKey)) as Record<string, unknown>;
  const signingInput = `${b64urlJson({ typ: "dpop+jwt", alg: "ES256", jwk: privateJwk })}.${b64urlJson(validPayload())}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, encoder.encode(signingInput));
  const proof = `${signingInput}.${b64url(new Uint8Array(signature))}`;
  assert.deepEqual(await verifyDpopProof(proof, options, memoryStore()), { ok: false, reason: "bad_key" });
});

test("a non-dpop typ or wrong alg is rejected", async () => {
  const keys = await ecKeys();
  const wrongTyp = await signProof(keys, validPayload(), { typ: "jwt" });
  const wrongAlg = await signProof(keys, validPayload(), { alg: "RS256" });
  assert.deepEqual(await verifyDpopProof(wrongTyp, options, memoryStore()), { ok: false, reason: "unsupported_alg" });
  assert.deepEqual(await verifyDpopProof(wrongAlg, options, memoryStore()), { ok: false, reason: "unsupported_alg" });
});
