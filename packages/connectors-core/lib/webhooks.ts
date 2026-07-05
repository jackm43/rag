import { timingSafeEqual } from "@rag/ingress/timing-safe-equal";

// Inbound webhook signature verification — the broker-side half of the webhook
// ingress design (AGENTS.md "A new webhook ingress").
// The edge receiver (the webhooks worker) reads the RAW request body and hands
// the broker the provider's signature headers plus the exact body bytes; the
// broker resolves the per-connector webhook secret, computes the provider's
// scheme, and returns a boolean. The secret never leaves the broker — the same
// phantom-token philosophy as authorizedFetch, applied inbound.
//
// This module is pure scheme code (which header, which HMAC construction); it
// knows nothing of connectors, Cedar, or the grant store — that is the broker
// infra (handler.ts), which looks up the connector's webhook config and
// resolves the secret before calling in here.
//
// Everything fails CLOSED to { valid: false }: a missing header, a malformed
// signature, a non-hex digest, an unknown provider, or a stale timestamp are
// all simply "not valid" — never an exception a caller could misread as
// transient. Digest comparisons are constant-time (timingSafeEqual) so a forger
// learns nothing from response timing.

export type WebhookProvider = "github" | "stripe";

export type WebhookVerification = {
  valid: boolean;
  // The provider's event id when one travels with the request (GitHub's
  // X-GitHub-Delivery header; Stripe's body `id`), for the receiver's
  // idempotency/replay dedupe. Populated ONLY on a valid signature so an
  // unverified value is never propagated.
  eventId?: string;
};

// Stripe's documented default tolerance for the signed timestamp: a signature
// older (or claiming to be newer) than this is treated as a replay.
export const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

// Case-insensitive header lookup — providers, proxies, and test fixtures
// disagree on header casing, and HTTP says it must not matter.
const headerValue = (headers: Record<string, string>, name: string): string | null => {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return null;
};

// Strict hex decode: even length, hex characters only. Anything else is a
// malformed signature and decodes to null (which verifies false).
const HEX_PATTERN = /^[0-9a-f]+$/i;
const bytesFromHex = (value: string): Uint8Array | null => {
  if (value.length === 0 || value.length % 2 !== 0 || !HEX_PATTERN.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const hmacSha256 = async (secret: string, message: Uint8Array): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, message as unknown as BufferSource);
  return new Uint8Array(signature);
};

// github scheme: `X-Hub-Signature-256: sha256=<hex>` where <hex> is
// HMAC-SHA256(secret, raw body). GitHub sends no signed timestamp; replay
// defence is the receiver's dedupe on the X-GitHub-Delivery id.
const verifyGithub = async (
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
): Promise<WebhookVerification> => {
  const header = headerValue(headers, "x-hub-signature-256");
  if (!header || !header.startsWith("sha256=")) {
    return { valid: false };
  }
  const presented = bytesFromHex(header.slice("sha256=".length));
  if (!presented) {
    return { valid: false };
  }
  const expected = await hmacSha256(secret, body);
  if (!timingSafeEqual(presented, expected)) {
    return { valid: false };
  }
  const deliveryId = headerValue(headers, "x-github-delivery");
  return { valid: true, ...(deliveryId ? { eventId: deliveryId } : {}) };
};

// The Stripe event id rides in the (now verified) body, not a header. Parsed
// only AFTER the signature checks out, and only for the dedupe hint — a body
// that is not JSON simply yields no eventId, not a failure.
const stripeEventId = (body: Uint8Array): string | undefined => {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { id?: unknown };
    return parsed && typeof parsed === "object" && typeof parsed.id === "string"
      ? parsed.id
      : undefined;
  } catch {
    return undefined;
  }
};

// stripe scheme: `Stripe-Signature: t=<epoch-seconds>,v1=<hex>[,v1=<hex>…]`.
// The signed payload is `<t>.<raw body>`; ANY v1 candidate may match (Stripe
// sends several during a secret rotation). The timestamp must sit inside the
// tolerance window in BOTH directions — a correctly-signed-but-stale message is
// a replay and verifies false.
const verifyStripe = async (
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
  nowMs: number,
  toleranceSeconds: number,
): Promise<WebhookVerification> => {
  const header = headerValue(headers, "stripe-signature");
  if (!header) {
    return { valid: false };
  }
  let timestamp: number | null = null;
  const candidates: Uint8Array[] = [];
  for (const element of header.split(",")) {
    const separator = element.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === "v1") {
      const bytes = bytesFromHex(value);
      if (bytes) {
        candidates.push(bytes);
      }
    }
  }
  if (timestamp === null || candidates.length === 0) {
    return { valid: false };
  }
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > toleranceSeconds) {
    return { valid: false };
  }
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);
  const expected = await hmacSha256(secret, signed);
  // Check every candidate (no early exit) so the comparison count does not
  // reveal which position matched.
  let matched = false;
  for (const candidate of candidates) {
    if (timingSafeEqual(candidate, expected)) {
      matched = true;
    }
  }
  if (!matched) {
    return { valid: false };
  }
  const eventId = stripeEventId(body);
  return { valid: true, ...(eventId ? { eventId } : {}) };
};

// Verify a provider's webhook signature over the exact body bytes. `provider`
// is typed as string because it arrives from the wire; anything but a known
// scheme fails closed. `nowMs`/`toleranceSeconds` are injectable for tests.
export const verifyWebhookSignature = async (input: {
  provider: string;
  secret: string;
  signatureHeaders: Record<string, string>;
  body: Uint8Array;
  nowMs?: number;
  toleranceSeconds?: number;
}): Promise<WebhookVerification> => {
  switch (input.provider) {
    case "github":
      return verifyGithub(input.secret, input.signatureHeaders, input.body);
    case "stripe":
      return verifyStripe(
        input.secret,
        input.signatureHeaders,
        input.body,
        input.nowMs ?? Date.now(),
        input.toleranceSeconds ?? STRIPE_TIMESTAMP_TOLERANCE_SECONDS,
      );
    default:
      return { valid: false };
  }
};
