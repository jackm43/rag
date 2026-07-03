// Signed identity-context tokens for service hops.
//
// Cloudflare service bindings and queues are in-process, isolate-to-isolate
// calls inside a single account: the *transport* identity ("which worker is
// calling") is guaranteed by the platform, because a binding/queue can only be
// invoked by a worker that is configured with it. That platform guarantee is
// the practical equivalent of mTLS transport-level identity here — we do NOT
// (and cannot, and need not) open literal mTLS sockets between isolates.
//
// What the platform does NOT carry is the *application* identity: who the
// request is on behalf of (the Discord user / OAuth-client sub) and an
// explicit, testable proof of which worker minted the hop. This module layers
// that on top as a compact JWS (RFC 7515) signed with the sending worker's
// Ed25519 key. The token is bound to the exact Cap'n Proto envelope bytes via
// envelopeSha256 so a captured token cannot be replayed against a different
// payload.
//
// Algorithm: Ed25519 (JWS "EdDSA"). workerd's WebCrypto implements Ed25519
// sign/verify and OKP JWK import natively (verified against the workerd test
// pool), so no dependency beyond globalThis.crypto.subtle is needed. Ed25519
// is preferred over ES256 for smaller keys/signatures and misuse-resistant,
// deterministic signing.

import {
  isMachinePrincipal,
  type MachinePrincipal,
  type TrustZone,
} from "../auth/principal";

export const IDENTITY_TOKEN_TYP = "ragbot-idctx+jws";

// Short-lived by design: a service hop is processed within seconds, so a 60s
// window bounds replay even before the envelope-hash binding is considered.
export const IDENTITY_CONTEXT_TTL_SECONDS = 60;

// Small allowance for clock differences between isolates.
const DEFAULT_CLOCK_SKEW_SECONDS = 5;

// The on-behalf-of identity context carried alongside each service envelope.
// Modelled on RFC 8693 (OAuth token exchange): `sub` is the subject the
// request acts for, `act` is the delegation chain of machine principals that
// have handled it.
export type IdentityContext = {
  // Discord user id, or SYSTEM_SUBJECT for user-less flows.
  sub: string;
  // Delegation chain, oldest first, each entry a machine principal the
  // request has traversed. RFC 8693 §4.1 style, flattened to an array.
  act: MachinePrincipal[];
  // Minting service (also the JWS `kid`).
  iss: MachinePrincipal;
  // Target service the token is addressed to.
  aud: MachinePrincipal;
  // Trust zone the token was minted from.
  trustZone: TrustZone;
  // Issued-at / expiry, seconds since epoch.
  iat: number;
  exp: number;
  // Unique token id.
  jti: string;
  // base64url(SHA-256(envelope bytes)) — binds the token to one payload.
  envelopeSha256: string;
};

export type PublicKeyResolver = (
  iss: string,
) => CryptoKey | null | Promise<CryptoKey | null>;

export type VerifyFailureReason =
  | "malformed"
  | "unsupported_alg"
  | "unknown_issuer"
  | "bad_signature"
  | "aud_mismatch"
  | "expired"
  | "not_yet_valid"
  | "envelope_mismatch";

export type VerifyOptions = {
  expectedAud: MachinePrincipal;
  expectedIssuers: readonly MachinePrincipal[];
  envelopeBytes: Uint8Array;
  // Seconds since epoch; defaults to the wall clock. Injected in tests.
  now?: number;
  clockSkewSeconds?: number;
};

export type VerifyResult =
  | { ok: true; context: IdentityContext }
  | { ok: false; reason: VerifyFailureReason };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ED25519 = { name: "Ed25519" } as const;

// crypto.subtle's lib types want an ArrayBuffer-backed view, but TextEncoder
// and capnp hand back Uint8Array<ArrayBufferLike>. The bytes here are always a
// full, non-shared buffer, so the view is a sound BufferSource.
const buf = (view: Uint8Array): BufferSource => view as unknown as BufferSource;

const b64urlFromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const bytesFromB64url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const b64urlJson = (value: unknown): string =>
  b64urlFromBytes(encoder.encode(JSON.stringify(value)));

const jsonFromB64url = (value: string): unknown =>
  JSON.parse(decoder.decode(bytesFromB64url(value)));

// base64url(SHA-256(bytes)); the value bound into a token and re-derived from
// the received bytes at the verifier.
export const envelopeSha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", buf(bytes));
  return b64urlFromBytes(new Uint8Array(digest));
};

export const importSigningKey = (jwk: JsonWebKey): Promise<CryptoKey> =>
  crypto.subtle.importKey("jwk", jwk, ED25519, false, ["sign"]);

export const importVerifyingKey = (jwk: JsonWebKey): Promise<CryptoKey> =>
  crypto.subtle.importKey("jwk", jwk, ED25519, false, ["verify"]);

// Assemble a fresh context for a hop: appends the issuer to the inbound
// delegation chain, stamps iat/exp/jti, and binds the envelope hash.
export const buildIdentityContext = async (params: {
  iss: MachinePrincipal;
  aud: MachinePrincipal;
  sub: string;
  trustZone: TrustZone;
  envelopeBytes: Uint8Array;
  // Prior delegation chain (the inbound context's `act`); empty at ingress.
  act?: MachinePrincipal[];
  now?: number;
  ttlSeconds?: number;
}): Promise<IdentityContext> => {
  const iat = Math.floor((params.now ?? Date.now()) / 1000);
  return {
    sub: params.sub,
    act: [...(params.act ?? []), params.iss],
    iss: params.iss,
    aud: params.aud,
    trustZone: params.trustZone,
    iat,
    exp: iat + (params.ttlSeconds ?? IDENTITY_CONTEXT_TTL_SECONDS),
    jti: crypto.randomUUID(),
    envelopeSha256: await envelopeSha256(params.envelopeBytes),
  };
};

// Sign a context into a compact JWS. The header pins alg=EdDSA and names the
// issuer as `kid` so a resolver can pick the key before parsing the payload.
export const mint = async (
  privateKey: CryptoKey,
  context: IdentityContext,
): Promise<string> => {
  const header = { alg: "EdDSA", typ: IDENTITY_TOKEN_TYP, kid: context.iss };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(context)}`;
  const signature = await crypto.subtle.sign(
    ED25519,
    privateKey,
    buf(encoder.encode(signingInput)),
  );
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`;
};

const asContext = (value: unknown): IdentityContext | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sub !== "string" ||
    !Array.isArray(candidate.act) ||
    !candidate.act.every(isMachinePrincipal) ||
    !isMachinePrincipal(candidate.iss) ||
    !isMachinePrincipal(candidate.aud) ||
    typeof candidate.trustZone !== "string" ||
    typeof candidate.iat !== "number" ||
    typeof candidate.exp !== "number" ||
    typeof candidate.jti !== "string" ||
    typeof candidate.envelopeSha256 !== "string"
  ) {
    return null;
  }
  return candidate as unknown as IdentityContext;
};

// Verify a token against a resolver and the receiver's expectations. Returns a
// tagged result and NEVER throws to the caller: any parse/crypto/policy
// failure is turned into { ok: false, reason }, so a boundary can always fall
// through to a clean deny. The signature is checked before any claim (aud,
// exp, envelope) is trusted.
export const verify = async (
  resolver: PublicKeyResolver,
  token: unknown,
  options: VerifyOptions,
): Promise<VerifyResult> => {
  try {
    if (typeof token !== "string") {
      return { ok: false, reason: "malformed" };
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "malformed" };
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const header = jsonFromB64url(encodedHeader) as Record<string, unknown>;
    if (header?.alg !== "EdDSA") {
      return { ok: false, reason: "unsupported_alg" };
    }

    const context = asContext(jsonFromB64url(encodedPayload));
    if (!context) {
      return { ok: false, reason: "malformed" };
    }

    if (!options.expectedIssuers.includes(context.iss)) {
      return { ok: false, reason: "unknown_issuer" };
    }
    const key = await resolver(context.iss);
    if (!key) {
      return { ok: false, reason: "unknown_issuer" };
    }

    const signatureValid = await crypto.subtle.verify(
      ED25519,
      key,
      buf(bytesFromB64url(encodedSignature)),
      buf(encoder.encode(`${encodedHeader}.${encodedPayload}`)),
    );
    if (!signatureValid) {
      return { ok: false, reason: "bad_signature" };
    }

    if (context.aud !== options.expectedAud) {
      return { ok: false, reason: "aud_mismatch" };
    }

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    if (now > context.exp + skew) {
      return { ok: false, reason: "expired" };
    }
    if (now + skew < context.iat) {
      return { ok: false, reason: "not_yet_valid" };
    }

    if (context.envelopeSha256 !== (await envelopeSha256(options.envelopeBytes))) {
      return { ok: false, reason: "envelope_mismatch" };
    }

    return { ok: true, context };
  } catch {
    return { ok: false, reason: "malformed" };
  }
};
