// DPoP (RFC 9449) proof verification for the dev-proxy's public browser client.
//
// The browser holds a non-extractable WebCrypto ES256 (P-256) keypair and, for
// every request, signs a fresh DPoP proof JWS binding the HTTP method (htm) and
// URI (htu) with a unique jti and iat. Verifying that proof gives the dev-proxy
// two things:
//   - a sender constraint: the request was made by the holder of a specific
//     private key, identified by its JWK thumbprint (jkt, RFC 7638). The
//     dev-proxy binds each session to a jkt, so a stolen session cookie is
//     useless without the matching private key.
//   - replay resistance: the (verified) jti is recorded for the proof's short
//     lifetime; a second presentation of the same proof is refused.
//
// This module is the pure, injectable-clock, injectable-replay-store verifier
// (exhaustively testable). The replay store is backed by a Durable Object in
// the dev-proxy worker (see workers/public/dev-proxy) — chosen over KV because
// a DO is single-threaded and strongly consistent, so the check-and-record is
// atomic and a replay cannot slip through KV's eventual-consistency /
// write-visibility window. Fail closed: any structural, signature, binding,
// freshness, or replay problem is a denial, and the verifier never throws.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_PROOF_LENGTH = 4096;
const DEFAULT_MAX_AGE_SECONDS = 60;
const DEFAULT_CLOCK_SKEW_SECONDS = 5;

const ES256_IMPORT = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256_VERIFY = { name: "ECDSA", hash: "SHA-256" } as const;

const buf = (view: Uint8Array): BufferSource => view as unknown as BufferSource;

const b64urlFromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

const jsonFromB64url = (value: string): unknown => JSON.parse(decoder.decode(bytesFromB64url(value)));

// RFC 7638 JWK thumbprint for an EC key: SHA-256 over the canonical JSON of the
// required members in lexicographic order ({crv, kty, x, y}), base64url. This
// is the jkt the session is bound to.
export const ecThumbprint = async (jwk: { crv: string; x: string; y: string }): Promise<string> => {
  const canonical = `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  const digest = await crypto.subtle.digest("SHA-256", buf(encoder.encode(canonical)));
  return b64urlFromBytes(new Uint8Array(digest));
};

export type DpopVerifyFailure =
  | "malformed"
  | "unsupported_alg"
  | "bad_key"
  | "bad_signature"
  | "htm_mismatch"
  | "htu_mismatch"
  | "stale"
  | "replayed";

export type DpopVerifyResult =
  | { ok: true; jkt: string; jti: string }
  | { ok: false; reason: DpopVerifyFailure };

// Records a verified jti for its lifetime and reports whether it had already
// been seen. Backed by a strongly-consistent Durable Object in production.
export type DpopReplayStore = {
  // Returns true if this jti was already recorded (a replay), false if it is
  // newly recorded. The ttl bounds how long the jti must be remembered.
  seenBefore: (jti: string, ttlSeconds: number) => Promise<boolean>;
};

export type DpopVerifyOptions = {
  // The HTTP method and canonical URI the proof must be bound to. htu should be
  // scheme://host/path with no query or fragment.
  htm: string;
  htu: string;
  now?: number;
  maxAgeSeconds?: number;
  clockSkewSeconds?: number;
};

type DpopHeader = { typ?: unknown; alg?: unknown; jwk?: unknown };
type DpopPayload = { htm?: unknown; htu?: unknown; jti?: unknown; iat?: unknown };

const isPublicEcJwk = (value: unknown): value is { kty: "EC"; crv: string; x: string; y: string } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const jwk = value as Record<string, unknown>;
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string" &&
    // A DPoP header MUST carry only the public key; a private component is a
    // malformed proof, not a usable key.
    jwk.d === undefined
  );
};

// Strip query and fragment so htu comparison is over scheme://host/path only.
const canonicalHtu = (value: string): string | null => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
};

export const verifyDpopProof = async (
  proof: unknown,
  options: DpopVerifyOptions,
  replay: DpopReplayStore,
): Promise<DpopVerifyResult> => {
  try {
    if (typeof proof !== "string" || proof.length === 0 || proof.length > MAX_PROOF_LENGTH) {
      return { ok: false, reason: "malformed" };
    }
    const parts = proof.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "malformed" };
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const header = jsonFromB64url(encodedHeader) as DpopHeader;
    if (header?.typ !== "dpop+jwt" || header?.alg !== "ES256") {
      return { ok: false, reason: "unsupported_alg" };
    }
    if (!isPublicEcJwk(header.jwk)) {
      return { ok: false, reason: "bad_key" };
    }

    // Verify against the key embedded in the proof — DPoP is self-signed, so
    // the binding to a session's jkt is what makes the key trustworthy, checked
    // by the caller against the returned jkt.
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("jwk", header.jwk, ES256_IMPORT, false, ["verify"]);
    } catch {
      return { ok: false, reason: "bad_key" };
    }
    const signatureValid = await crypto.subtle.verify(
      ES256_VERIFY,
      key,
      buf(bytesFromB64url(encodedSignature)),
      buf(encoder.encode(`${encodedHeader}.${encodedPayload}`)),
    );
    if (!signatureValid) {
      return { ok: false, reason: "bad_signature" };
    }

    const payload = jsonFromB64url(encodedPayload) as DpopPayload;
    if (typeof payload.htm !== "string" || payload.htm.toUpperCase() !== options.htm.toUpperCase()) {
      return { ok: false, reason: "htm_mismatch" };
    }
    const expectedHtu = canonicalHtu(options.htu);
    if (typeof payload.htu !== "string" || expectedHtu === null || canonicalHtu(payload.htu) !== expectedHtu) {
      return { ok: false, reason: "htu_mismatch" };
    }

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    if (typeof payload.iat !== "number" || now + skew < payload.iat || now - payload.iat > maxAge + skew) {
      return { ok: false, reason: "stale" };
    }

    if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 256) {
      return { ok: false, reason: "malformed" };
    }

    const jkt = await ecThumbprint(header.jwk);

    // Replay check LAST, and only after the signature is proven, so an attacker
    // cannot flood the store with unsigned jtis. Remember the jti for its whole
    // acceptance window (maxAge + skew).
    if (await replay.seenBefore(payload.jti, maxAge + skew)) {
      return { ok: false, reason: "replayed" };
    }

    return { ok: true, jkt, jti: payload.jti };
  } catch {
    return { ok: false, reason: "malformed" };
  }
};
