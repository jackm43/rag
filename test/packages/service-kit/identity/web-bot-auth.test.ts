import { assert, test } from "vitest";

import {
  jwkThumbprint,
  signRequest,
  verifyRequest,
  webBotAuthDirectory,
  WEB_BOT_AUTH_TAG,
} from "@rag/service-kit/identity";

// Web Bot Auth signs the OUTBOUND edge: an RFC 9421 HTTP Message Signature over
// the target `@authority` (and, when advertised, the Signature-Agent directory),
// tagged `web-bot-auth`, keyed by the signer's RFC 7638 JWK Thumbprint. In prod
// the origin (Cloudflare) verifies; here we round-trip our own signer against
// our own verifier to pin the wire format and the failure modes.

const NOW_S = 1_700_000_000;

const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;

const publicJwkOf = (pair: CryptoKeyPair): Promise<JsonWebKey> =>
  crypto.subtle.exportKey("jwk", pair.publicKey);

// A resolver that always returns the one key we generated, regardless of keyid —
// keyid matching is exercised separately via the directory thumbprint.
const constantResolver = (key: CryptoKey) => () => key;

test("a signed request round-trips through the verifier within its window", async () => {
  const pair = await generateKeyPair();
  const publicJwk = await publicJwkOf(pair);

  const headers = await signRequest(
    pair.privateKey,
    publicJwk,
    { url: "https://example.com/search?q=cats" },
    { created: NOW_S, signatureAgent: "https://ragbot.jsmunro.me" },
  );

  const result = await verifyRequest(
    constantResolver(pair.publicKey),
    { url: "https://example.com/search?q=cats", headers: new Headers(headers) },
    { now: NOW_S + 10 },
  );

  assert.isTrue(result.ok);
  if (result.ok) {
    assert.equal(result.keyid, await jwkThumbprint(publicJwk));
    assert.equal(result.created, NOW_S);
  }
});

test("the emitted headers carry the web-bot-auth tag, keyid, and directory", async () => {
  const pair = await generateKeyPair();
  const publicJwk = await publicJwkOf(pair);

  const headers = await signRequest(
    pair.privateKey,
    publicJwk,
    { url: "https://example.com/" },
    { created: NOW_S, signatureAgent: "https://ragbot.jsmunro.me" },
  );

  assert.match(headers["Signature-Input"], /tag="web-bot-auth"/);
  assert.include(headers["Signature-Input"], `keyid="${await jwkThumbprint(publicJwk)}"`);
  assert.include(headers["Signature-Input"], '"@authority" "signature-agent"');
  assert.equal(headers["Signature-Agent"], '"https://ragbot.jsmunro.me"');
  assert.match(headers.Signature, /^sig1=:.+:$/);
});

test("a signature bound to one authority is refused against another", async () => {
  const pair = await generateKeyPair();
  const publicJwk = await publicJwkOf(pair);

  const headers = await signRequest(pair.privateKey, publicJwk, { url: "https://example.com/" }, { created: NOW_S });

  const result = await verifyRequest(
    constantResolver(pair.publicKey),
    { url: "https://evil.example.net/", headers: new Headers(headers) },
    { now: NOW_S },
  );

  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("a request with no directory omits Signature-Agent and still verifies", async () => {
  const pair = await generateKeyPair();
  const publicJwk = await publicJwkOf(pair);

  const headers = await signRequest(pair.privateKey, publicJwk, { url: "https://example.com/" }, { created: NOW_S });
  assert.isUndefined(headers["Signature-Agent"]);
  assert.include(headers["Signature-Input"], '("@authority")');

  const result = await verifyRequest(
    constantResolver(pair.publicKey),
    { url: "https://example.com/", headers: new Headers(headers) },
    { now: NOW_S },
  );
  assert.isTrue(result.ok);
});

test("a signature is refused once past its expiry", async () => {
  const pair = await generateKeyPair();
  const publicJwk = await publicJwkOf(pair);

  const headers = await signRequest(
    pair.privateKey,
    publicJwk,
    { url: "https://example.com/" },
    { created: NOW_S, ttlSeconds: 60 },
  );

  const result = await verifyRequest(
    constantResolver(pair.publicKey),
    { url: "https://example.com/", headers: new Headers(headers) },
    { now: NOW_S + 61 },
  );

  assert.deepEqual(result, { ok: false, reason: "expired" });
});

test("a signature from a different key is refused", async () => {
  const signer = await generateKeyPair();
  const impostor = await generateKeyPair();
  const publicJwk = await publicJwkOf(signer);

  const headers = await signRequest(signer.privateKey, publicJwk, { url: "https://example.com/" }, { created: NOW_S });

  const result = await verifyRequest(
    constantResolver(impostor.publicKey),
    { url: "https://example.com/", headers: new Headers(headers) },
    { now: NOW_S },
  );

  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("an unresolvable keyid is refused before signature checking", async () => {
  const pair = await generateKeyPair();
  const publicJwk = await publicJwkOf(pair);

  const headers = await signRequest(pair.privateKey, publicJwk, { url: "https://example.com/" }, { created: NOW_S });

  const result = await verifyRequest(
    () => null,
    { url: "https://example.com/", headers: new Headers(headers) },
    { now: NOW_S },
  );

  assert.deepEqual(result, { ok: false, reason: "unknown_key" });
});

test("a request without signature headers is refused as missing", async () => {
  const pair = await generateKeyPair();
  const result = await verifyRequest(
    constantResolver(pair.publicKey),
    { url: "https://example.com/", headers: new Headers() },
    { now: NOW_S },
  );
  assert.deepEqual(result, { ok: false, reason: "missing_signature" });
});

test("a signature carrying an unexpected tag is refused", async () => {
  const pair = await generateKeyPair();
  const publicJwk = await publicJwkOf(pair);
  const headers = await signRequest(pair.privateKey, publicJwk, { url: "https://example.com/" }, { created: NOW_S });

  // Corrupt the tag: an origin's web-bot-auth verifier must not accept it.
  const tampered = new Headers(headers);
  tampered.set("Signature-Input", headers["Signature-Input"].replace(WEB_BOT_AUTH_TAG, "some-other-tag"));

  const result = await verifyRequest(
    constantResolver(pair.publicKey),
    { url: "https://example.com/", headers: tampered },
    { now: NOW_S },
  );
  assert.deepEqual(result, { ok: false, reason: "unexpected_tag" });
});

test("the directory publishes the public point keyed by its own thumbprint", async () => {
  const pair = await generateKeyPair();
  const publicJwk = await publicJwkOf(pair);

  const directory = await webBotAuthDirectory(publicJwk);
  assert.lengthOf(directory.keys, 1);
  const [key] = directory.keys as Array<JsonWebKey & { kid: string; use: string; alg: string }>;
  assert.equal(key.kid, await jwkThumbprint(publicJwk));
  assert.equal(key.x, publicJwk.x);
  assert.equal(key.use, "sig");
  assert.equal(key.alg, "EdDSA");
  // The private scalar must never be published.
  assert.notProperty(key, "d");
});

test("the JWK thumbprint is stable and independent of member order", async () => {
  const pair = await generateKeyPair();
  const publicJwk = await publicJwkOf(pair);

  const a = await jwkThumbprint(publicJwk);
  const b = await jwkThumbprint({ x: publicJwk.x, kty: publicJwk.kty, crv: publicJwk.crv, use: "sig", kid: "ignored" });
  assert.equal(a, b);
});
