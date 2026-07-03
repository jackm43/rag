import { assert, test } from "vitest";

import type { MachinePrincipal } from "../../../packages/auth/principal.ts";
import {
  buildIdentityContext,
  keyringResolver,
  mint,
  PUBLIC_KEYRING,
  verify,
  type PublicKeyResolver,
} from "../../../packages/identity/index.ts";

const encoder = new TextEncoder();
const envelope = () => encoder.encode("cap-n-proto-envelope-bytes");

// A fresh Ed25519 keypair plus a resolver that serves its public key for one
// issuer. Mirrors the production shape (private key in a secret, public key in
// the keyring) without depending on the committed keys.
const keypairFor = async (iss: MachinePrincipal) => {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const resolver: PublicKeyResolver = (candidate) =>
    candidate === iss ? keyPair.publicKey : null;
  return { privateKey: keyPair.privateKey, resolver };
};

const gatewayToBrain = async (now = 1_000) => {
  const bytes = envelope();
  const { privateKey, resolver } = await keypairFor("gateway");
  const context = await buildIdentityContext({
    iss: "gateway",
    aud: "brain",
    sub: "107426926909517824",
    trustZone: "edge",
    envelopeBytes: bytes,
    now: now * 1000,
  });
  return { token: await mint(privateKey, context), resolver, bytes, context };
};

test("a minted token verifies against the issuer's key and returns its context", async () => {
  const { token, resolver, bytes, context } = await gatewayToBrain();
  const result = await verify(resolver, token, {
    expectedAud: "brain",
    expectedIssuers: ["gateway"],
    envelopeBytes: bytes,
    now: 1_010,
  });
  assert.isTrue(result.ok);
  if (result.ok) {
    assert.equal(result.context.sub, "107426926909517824");
    assert.deepEqual(result.context.act, ["gateway"]);
    assert.equal(result.context.jti, context.jti);
  }
});

test("a token addressed to another worker is denied with aud_mismatch", async () => {
  const { token, resolver, bytes } = await gatewayToBrain();
  const result = await verify(resolver, token, {
    expectedAud: "responder",
    expectedIssuers: ["gateway"],
    envelopeBytes: bytes,
    now: 1_010,
  });
  assert.deepEqual(result, { ok: false, reason: "aud_mismatch" });
});

test("a token past its expiry window is denied", async () => {
  const { token, resolver, bytes } = await gatewayToBrain(1_000);
  const result = await verify(resolver, token, {
    expectedAud: "brain",
    expectedIssuers: ["gateway"],
    envelopeBytes: bytes,
    now: 1_000 + 60 + 10,
  });
  assert.deepEqual(result, { ok: false, reason: "expired" });
});

test("a token replayed against different envelope bytes is denied", async () => {
  const { token, resolver } = await gatewayToBrain();
  const result = await verify(resolver, token, {
    expectedAud: "brain",
    expectedIssuers: ["gateway"],
    envelopeBytes: encoder.encode("a-different-payload"),
    now: 1_010,
  });
  assert.deepEqual(result, { ok: false, reason: "envelope_mismatch" });
});

test("a token from an unexpected issuer is denied", async () => {
  const { token, resolver, bytes } = await gatewayToBrain();
  const notExpected = await verify(resolver, token, {
    expectedAud: "brain",
    expectedIssuers: ["responder"],
    envelopeBytes: bytes,
    now: 1_010,
  });
  assert.deepEqual(notExpected, { ok: false, reason: "unknown_issuer" });

  // Expected issuer, but the resolver has no key for it.
  const noKey = await verify(() => null, token, {
    expectedAud: "brain",
    expectedIssuers: ["gateway"],
    envelopeBytes: bytes,
    now: 1_010,
  });
  assert.deepEqual(noKey, { ok: false, reason: "unknown_issuer" });
});

test("a tampered signature is denied", async () => {
  const { token, resolver, bytes } = await gatewayToBrain();
  const [header, payload, signature] = token.split(".");
  // Flip the FIRST signature character so a full high-order bit group of byte 0
  // changes; tampering the last base64url char can touch only non-significant
  // trailing bits and decode to the same 64-byte signature (a flaky no-op).
  const flipped = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const result = await verify(resolver, `${header}.${payload}.${flipped}`, {
    expectedAud: "brain",
    expectedIssuers: ["gateway"],
    envelopeBytes: bytes,
    now: 1_010,
  });
  assert.isFalse(result.ok);
  if (!result.ok) {
    assert.oneOf(result.reason, ["bad_signature", "malformed"]);
  }
});

test("a token whose payload is edited after signing is denied", async () => {
  const { token, resolver, bytes } = await gatewayToBrain();
  const [header, , signature] = token.split(".");
  const forgedPayload = btoa(
    JSON.stringify({
      sub: "999",
      act: ["gateway"],
      iss: "gateway",
      aud: "brain",
      trustZone: "edge",
      iat: 1_000,
      exp: 1_060,
      jti: "forged",
      envelopeSha256: "x",
    }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const result = await verify(resolver, `${header}.${forgedPayload}.${signature}`, {
    expectedAud: "brain",
    expectedIssuers: ["gateway"],
    envelopeBytes: bytes,
    now: 1_010,
  });
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("the committed keyring resolves known workers and rejects unknown ones", async () => {
  for (const worker of Object.keys(PUBLIC_KEYRING) as MachinePrincipal[]) {
    assert.isNotNull(await keyringResolver(worker), worker);
  }
  assert.isNull(await keyringResolver("nope"));
});
