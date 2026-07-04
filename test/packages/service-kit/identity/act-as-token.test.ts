import { assert, test } from "vitest";

import {
  ACT_AS_TTL_SECONDS,
  buildActAsContext,
  mintActAs,
  verifyActAs,
} from "@rag/service-kit/identity";

// Act-as tokens are the Phase-3 authority DO's proof that one application may
// act as another for a single hop. They mirror the identity-context token's
// mechanics — EdDSA JWS, 60s-lived, bound to the exact envelope bytes — but name
// applications by open string ids rather than the closed MachinePrincipal union.
// A token is worthless off its envelope or past its window, and a receiver must
// only ever trust one signed by the issuer's real key for its own audience.

const encoder = new TextEncoder();
const envelope = (value: string) => encoder.encode(value);

const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;

// buildActAsContext takes `now` in milliseconds (it divides by 1000), verify
// takes it in seconds — the same split as token.ts. Keep both in lockstep.
const NOW_S = 1_700_000_000;
const NOW_MS = NOW_S * 1000;

const context = (overrides: Partial<Parameters<typeof buildActAsContext>[0]> = {}) =>
  buildActAsContext({
    iss: "authority-app",
    sub: "target-app",
    act: "member-service",
    aud: "connectors",
    envelopeBytes: envelope("envelope-A"),
    now: NOW_MS,
    ...overrides,
  });

test("mintActAs round-trips verifyActAs with envelope binding and a 60s window", async () => {
  const keys = await generateKeyPair();
  const ctx = await context();
  assert.equal(ctx.exp, NOW_S + ACT_AS_TTL_SECONDS);

  const token = await mintActAs(keys.privateKey, ctx);
  const result = await verifyActAs(() => keys.publicKey, token, {
    expectedAud: "connectors",
    envelopeBytes: envelope("envelope-A"),
    now: NOW_S,
  });

  assert.isTrue(result.ok);
  if (result.ok) {
    assert.equal(result.context.iss, "authority-app");
    assert.equal(result.context.sub, "target-app");
    assert.equal(result.context.act, "member-service");
    assert.equal(result.context.aud, "connectors");
  }
});

test("a token bound to envelope A is refused against envelope B", async () => {
  const keys = await generateKeyPair();
  const token = await mintActAs(keys.privateKey, await context({ envelopeBytes: envelope("envelope-A") }));

  const result = await verifyActAs(() => keys.publicKey, token, {
    expectedAud: "connectors",
    envelopeBytes: envelope("envelope-B"),
    now: NOW_S,
  });

  assert.deepEqual(result, { ok: false, reason: "envelope_mismatch" });
});

test("a token is refused once past its expiry plus skew", async () => {
  const keys = await generateKeyPair();
  const token = await mintActAs(keys.privateKey, await context());

  const result = await verifyActAs(() => keys.publicKey, token, {
    expectedAud: "connectors",
    envelopeBytes: envelope("envelope-A"),
    now: NOW_S + ACT_AS_TTL_SECONDS + 10,
  });

  assert.deepEqual(result, { ok: false, reason: "expired" });
});

test("a token minted for one audience is refused at another", async () => {
  const keys = await generateKeyPair();
  const token = await mintActAs(keys.privateKey, await context({ aud: "connectors" }));

  const result = await verifyActAs(() => keys.publicKey, token, {
    expectedAud: "workflows",
    envelopeBytes: envelope("envelope-A"),
    now: NOW_S,
  });

  assert.deepEqual(result, { ok: false, reason: "aud_mismatch" });
});

test("an issuer with no resolvable key is refused", async () => {
  const keys = await generateKeyPair();
  const token = await mintActAs(keys.privateKey, await context());

  const result = await verifyActAs(() => null, token, {
    expectedAud: "connectors",
    envelopeBytes: envelope("envelope-A"),
    now: NOW_S,
  });

  assert.deepEqual(result, { ok: false, reason: "unknown_issuer" });
});

test("an issuer-pin mismatch is refused before the resolver is consulted", async () => {
  const keys = await generateKeyPair();
  const token = await mintActAs(keys.privateKey, await context({ iss: "authority-app" }));
  let resolverCalled = false;

  const result = await verifyActAs(
    () => {
      resolverCalled = true;
      return keys.publicKey;
    },
    token,
    {
      expectedAud: "connectors",
      expectedIssuer: "a-different-authority",
      envelopeBytes: envelope("envelope-A"),
      now: NOW_S,
    },
  );

  assert.deepEqual(result, { ok: false, reason: "unknown_issuer" });
  assert.isFalse(resolverCalled);
});

test("a signature from a different key is refused", async () => {
  const signer = await generateKeyPair();
  const impostor = await generateKeyPair();
  const token = await mintActAs(signer.privateKey, await context());

  const result = await verifyActAs(() => impostor.publicKey, token, {
    expectedAud: "connectors",
    envelopeBytes: envelope("envelope-A"),
    now: NOW_S,
  });

  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});
