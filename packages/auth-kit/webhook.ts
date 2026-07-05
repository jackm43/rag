import { timingSafeEqual } from "./timing-safe-equal";

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

export type WebhookProvider = "github";

export type WebhookVerification = {
  valid: boolean;
  // The provider's event id when one travels with the request (GitHub's
  // X-GitHub-Delivery header), for the receiver's idempotency/replay dedupe.
  // Populated ONLY on a valid signature so an unverified value is never
  // propagated.
  eventId?: string;
};

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

// Verify a provider's webhook signature over the exact body bytes. `provider`
// is typed as string because it arrives from the wire; anything but a known
// scheme fails closed.
export const verifyWebhookSignature = async (input: {
  provider: string;
  secret: string;
  signatureHeaders: Record<string, string>;
  body: Uint8Array;
}): Promise<WebhookVerification> => {
  switch (input.provider) {
    case "github":
      return verifyGithub(input.secret, input.signatureHeaders, input.body);
    default:
      return { valid: false };
  }
};

// The per-provider webhook secret env var. The auth service holds these; a
// provider with no configured secret fails closed.
const WEBHOOK_SECRET_ENV: Record<string, string> = {
  github: "GITHUB_WEBHOOK_SECRET",
};

export type WebhookVerifyInput = {
  provider: string;
  signatureHeaders: Record<string, string>;
  bodyBase64: string;
};

// Resolve the provider's webhook secret from env and verify the signature. This
// is the auth service's inbound-webhook authn: the secret and the HMAC never
// leave the auth worker; the caller (webhooks) learns only { valid, eventId? }.
export const verifyWebhook = async (
  env: Record<string, unknown>,
  input: WebhookVerifyInput,
): Promise<WebhookVerification> => {
  const secretVar = WEBHOOK_SECRET_ENV[input.provider];
  const secret = secretVar ? env[secretVar] : undefined;
  if (typeof secret !== "string" || secret.length === 0) {
    return { valid: false };
  }
  const binary = atob(input.bodyBase64);
  const body = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    body[index] = binary.charCodeAt(index);
  }
  return verifyWebhookSignature({ provider: input.provider, secret, signatureHeaders: input.signatureHeaders, body });
};
