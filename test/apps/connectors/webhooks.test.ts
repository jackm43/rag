import { assert, test } from "vitest";

import {
  STRIPE_TIMESTAMP_TOLERANCE_SECONDS,
  verifyWebhookSignature,
} from "@rag/connectors/lib/webhooks";

// Security-critical crypto: webhook signature verification is the ONLY gate
// between an arbitrary internet POST and a message the system treats as a
// provider event, so it must fail closed. These tests prove each scheme
// verifies a genuine signature, refuses a tampered body, a wrong secret, and
// malformed headers, and that the stripe timestamp tolerance rejects replays —
// a test is the only way to prove the gate fails closed.

const encoder = new TextEncoder();

const hmacHex = async (secret: string, message: Uint8Array): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, message as unknown as BufferSource),
  );
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const SECRET = "whsec_test_secret";
const BODY = encoder.encode(JSON.stringify({ id: "evt_123", action: "opened" }));

// ---------------------------------------------------------------------------
// github: X-Hub-Signature-256: sha256=<hex of HMAC-SHA256(secret, body)>
// ---------------------------------------------------------------------------

const githubHeaders = async (
  body: Uint8Array,
  secret = SECRET,
): Promise<Record<string, string>> => ({
  // Provider casing on purpose: lookup must be case-insensitive.
  "X-Hub-Signature-256": `sha256=${await hmacHex(secret, body)}`,
  "X-GitHub-Delivery": "delivery-uuid-1",
});

test("github: a genuine signature verifies and carries the delivery id", async () => {
  const result = await verifyWebhookSignature({
    provider: "github",
    secret: SECRET,
    signatureHeaders: await githubHeaders(BODY),
    body: BODY,
  });
  assert.isTrue(result.valid);
  assert.equal(result.eventId, "delivery-uuid-1");
});

test("github: a tampered body fails, and no eventId is disclosed", async () => {
  const headers = await githubHeaders(BODY);
  const tampered = encoder.encode(JSON.stringify({ id: "evt_123", action: "deleted" }));
  const result = await verifyWebhookSignature({
    provider: "github",
    secret: SECRET,
    signatureHeaders: headers,
    body: tampered,
  });
  assert.isFalse(result.valid);
  assert.isUndefined(result.eventId);
});

test("github: a signature computed with the wrong secret fails", async () => {
  const result = await verifyWebhookSignature({
    provider: "github",
    secret: SECRET,
    signatureHeaders: await githubHeaders(BODY, "a-different-secret"),
    body: BODY,
  });
  assert.isFalse(result.valid);
});

test("github: malformed or missing signature headers all fail closed", async () => {
  const digest = await hmacHex(SECRET, BODY);
  const malformed: Record<string, string>[] = [
    {}, // header missing entirely
    { "x-hub-signature-256": digest }, // no sha256= prefix
    { "x-hub-signature-256": `sha1=${digest}` }, // wrong scheme prefix
    { "x-hub-signature-256": "sha256=" }, // empty digest
    { "x-hub-signature-256": "sha256=not-hex-at-all" }, // non-hex digest
    { "x-hub-signature-256": `sha256=${digest.slice(0, 32)}` }, // truncated digest
  ];
  for (const signatureHeaders of malformed) {
    const result = await verifyWebhookSignature({
      provider: "github",
      secret: SECRET,
      signatureHeaders,
      body: BODY,
    });
    assert.isFalse(result.valid, JSON.stringify(signatureHeaders));
  }
});

// ---------------------------------------------------------------------------
// stripe: Stripe-Signature: t=<ts>,v1=<hex of HMAC-SHA256(secret, `${t}.${body}`)>
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

const stripeSignature = async (
  body: Uint8Array,
  timestamp: number,
  secret = SECRET,
): Promise<string> => {
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);
  return hmacHex(secret, signed);
};

test("stripe: a genuine, fresh signature verifies and carries the body event id", async () => {
  const header = `t=${NOW_SECONDS},v1=${await stripeSignature(BODY, NOW_SECONDS)}`;
  const result = await verifyWebhookSignature({
    provider: "stripe",
    secret: SECRET,
    signatureHeaders: { "Stripe-Signature": header },
    body: BODY,
    nowMs: NOW_MS,
  });
  assert.isTrue(result.valid);
  assert.equal(result.eventId, "evt_123");
});

test("stripe: any matching v1 among several verifies (secret-rotation shape)", async () => {
  const genuine = await stripeSignature(BODY, NOW_SECONDS);
  const stale = await stripeSignature(BODY, NOW_SECONDS, "old-rotated-secret");
  const header = `t=${NOW_SECONDS},v1=${stale},v1=${genuine},v0=deadbeef`;
  const result = await verifyWebhookSignature({
    provider: "stripe",
    secret: SECRET,
    signatureHeaders: { "stripe-signature": header },
    body: BODY,
    nowMs: NOW_MS,
  });
  assert.isTrue(result.valid);
});

test("stripe: a tampered body fails", async () => {
  const header = `t=${NOW_SECONDS},v1=${await stripeSignature(BODY, NOW_SECONDS)}`;
  const tampered = encoder.encode(JSON.stringify({ id: "evt_123", amount: 999999 }));
  const result = await verifyWebhookSignature({
    provider: "stripe",
    secret: SECRET,
    signatureHeaders: { "stripe-signature": header },
    body: tampered,
    nowMs: NOW_MS,
  });
  assert.isFalse(result.valid);
});

test("stripe: the wrong secret fails", async () => {
  const header = `t=${NOW_SECONDS},v1=${await stripeSignature(BODY, NOW_SECONDS, "wrong")}`;
  const result = await verifyWebhookSignature({
    provider: "stripe",
    secret: SECRET,
    signatureHeaders: { "stripe-signature": header },
    body: BODY,
    nowMs: NOW_MS,
  });
  assert.isFalse(result.valid);
});

test("stripe: a correctly-signed but STALE timestamp is a replay and fails", async () => {
  // One second beyond the tolerance, in each direction; the signature itself is
  // genuine for that timestamp, so only the tolerance check can refuse it.
  for (const skew of [
    -(STRIPE_TIMESTAMP_TOLERANCE_SECONDS + 1),
    STRIPE_TIMESTAMP_TOLERANCE_SECONDS + 1,
  ]) {
    const timestamp = NOW_SECONDS + skew;
    const header = `t=${timestamp},v1=${await stripeSignature(BODY, timestamp)}`;
    const result = await verifyWebhookSignature({
      provider: "stripe",
      secret: SECRET,
      signatureHeaders: { "stripe-signature": header },
      body: BODY,
      nowMs: NOW_MS,
    });
    assert.isFalse(result.valid, `skew ${skew}s must be refused`);
  }
  // The boundary itself (exactly the tolerance) still verifies.
  const edge = NOW_SECONDS - STRIPE_TIMESTAMP_TOLERANCE_SECONDS;
  const header = `t=${edge},v1=${await stripeSignature(BODY, edge)}`;
  const result = await verifyWebhookSignature({
    provider: "stripe",
    secret: SECRET,
    signatureHeaders: { "stripe-signature": header },
    body: BODY,
    nowMs: NOW_MS,
  });
  assert.isTrue(result.valid);
});

test("stripe: malformed or missing signature headers all fail closed", async () => {
  const genuine = await stripeSignature(BODY, NOW_SECONDS);
  const malformed: Record<string, string>[] = [
    {}, // header missing entirely
    { "stripe-signature": "" },
    { "stripe-signature": `v1=${genuine}` }, // no timestamp
    { "stripe-signature": `t=${NOW_SECONDS}` }, // no v1
    { "stripe-signature": `t=notanumber,v1=${genuine}` }, // non-numeric timestamp
    { "stripe-signature": `t=${NOW_SECONDS},v1=not-hex` }, // non-hex digest
    { "stripe-signature": "complete,garbage" },
  ];
  for (const signatureHeaders of malformed) {
    const result = await verifyWebhookSignature({
      provider: "stripe",
      secret: SECRET,
      signatureHeaders,
      body: BODY,
      nowMs: NOW_MS,
    });
    assert.isFalse(result.valid, JSON.stringify(signatureHeaders));
  }
});

// ---------------------------------------------------------------------------
// scheme selection
// ---------------------------------------------------------------------------

test("an unknown provider fails closed, even with a valid github signature attached", async () => {
  const result = await verifyWebhookSignature({
    provider: "not-a-scheme",
    secret: SECRET,
    signatureHeaders: await githubHeaders(BODY),
    body: BODY,
  });
  assert.isFalse(result.valid);
});
