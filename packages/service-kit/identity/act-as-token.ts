// Act-as tokens: an application authority DO's proof that one application may
// act as another for a single, envelope-bound hop.
//
// Distinct from the identity-context token (token.ts), which carries the
// on-behalf-of *subject* and a delegation chain of MachinePrincipals — a CLOSED
// union with exhaustive per-principal policy maps that must not grow. An act-as
// token instead names APPLICATIONS by their registered ids (Discord app/client
// id, GitHub App client id, connector id, …), which are open-ended string
// identifiers the per-application authority (Phase 3) mints and resolves. So
// this is a parallel, string-typed context rather than a widening of
// IdentityContext/MachinePrincipal.
//
// Shape and mechanics mirror token.ts exactly — a compact EdDSA JWS bound to the
// exact envelope bytes via envelopeSha256, 60s-lived — and reuse token.ts's
// generic crypto/codec helpers so there is one signing/parsing implementation.
// The authority DO holds the signing key and returns only tokens; a receiver
// verifies with the issuer application's public key.

import {
  b64urlFromBytes,
  b64urlJson,
  bytesFromB64url,
  envelopeSha256,
  jsonFromB64url,
} from "./token";

export const ACT_AS_TOKEN_TYP = "ragbot-actas+jws";

// Short-lived by design: an act-as hop is consumed within seconds, so a 60s
// window bounds replay even before the envelope-hash binding is considered.
export const ACT_AS_TTL_SECONDS = 60;

const DEFAULT_CLOCK_SKEW_SECONDS = 5;
const ED25519 = { name: "Ed25519" } as const;
const encoder = new TextEncoder();

// crypto.subtle wants an ArrayBuffer-backed view; the bytes here are always a
// full, non-shared buffer, so the view is a sound BufferSource (mirrors token.ts).
const buf = (view: Uint8Array): BufferSource => view as unknown as BufferSource;

// The act-as assertion. RFC 8693-flavoured, but every principal is an
// application id string: `sub` is the application being acted AS, `act` is the
// member application/service doing the acting, `iss` is the application
// authority that minted (and vouches for) the assertion, `aud` is the service
// the token is presented to.
export type ActAsContext = {
  iss: string;
  sub: string;
  act: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  // base64url(SHA-256(envelope bytes)) — binds the token to one payload.
  envelopeSha256: string;
};

export type ActAsPublicKeyResolver = (
  iss: string,
) => CryptoKey | null | Promise<CryptoKey | null>;

export type ActAsVerifyFailureReason =
  | "malformed"
  | "unsupported_alg"
  | "unknown_issuer"
  | "bad_signature"
  | "aud_mismatch"
  | "expired"
  | "envelope_mismatch";

export type ActAsVerifyOptions = {
  expectedAud: string;
  // Optional issuer pin: when set, the token's `iss` must match before the key
  // resolver is consulted. The resolver remains the authority on which issuers
  // have a known key.
  expectedIssuer?: string;
  envelopeBytes: Uint8Array;
  // Seconds since epoch; defaults to the wall clock. Injected in tests.
  now?: number;
  clockSkewSeconds?: number;
};

export type ActAsVerifyResult =
  | { ok: true; context: ActAsContext }
  | { ok: false; reason: ActAsVerifyFailureReason };

// Stamp a fresh 60s act-as assertion bound to the envelope hash. The binding is
// supplied either as the raw envelope bytes or as a precomputed
// base64url(SHA-256(envelope)): the application authority mints from the hash
// alone, so a caller never ships the payload bytes to the authority DO to get a
// token, while an in-process minter can pass the bytes and let this hash them.
export const buildActAsContext = async (params: {
  iss: string;
  sub: string;
  act: string;
  aud: string;
  envelopeBytes?: Uint8Array;
  envelopeSha256?: string;
  now?: number;
  ttlSeconds?: number;
}): Promise<ActAsContext> => {
  const digest =
    params.envelopeSha256 ??
    (params.envelopeBytes ? await envelopeSha256(params.envelopeBytes) : null);
  if (digest === null) {
    throw new Error("buildActAsContext requires envelopeBytes or envelopeSha256");
  }
  const iat = Math.floor((params.now ?? Date.now()) / 1000);
  return {
    iss: params.iss,
    sub: params.sub,
    act: params.act,
    aud: params.aud,
    iat,
    exp: iat + (params.ttlSeconds ?? ACT_AS_TTL_SECONDS),
    jti: crypto.randomUUID(),
    envelopeSha256: digest,
  };
};

// Sign a context into a compact JWS. The header pins alg=EdDSA and names the
// issuer as `kid` so a resolver can pick the key before parsing the payload.
export const mintActAs = async (
  privateKey: CryptoKey,
  context: ActAsContext,
): Promise<string> => {
  const header = { alg: "EdDSA", typ: ACT_AS_TOKEN_TYP, kid: context.iss };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(context)}`;
  const signature = await crypto.subtle.sign(
    ED25519,
    privateKey,
    buf(encoder.encode(signingInput)),
  );
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`;
};

const asActAsContext = (value: unknown): ActAsContext | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.iss !== "string" ||
    typeof candidate.sub !== "string" ||
    typeof candidate.act !== "string" ||
    typeof candidate.aud !== "string" ||
    typeof candidate.iat !== "number" ||
    typeof candidate.exp !== "number" ||
    typeof candidate.jti !== "string" ||
    typeof candidate.envelopeSha256 !== "string"
  ) {
    return null;
  }
  return candidate as unknown as ActAsContext;
};

// Verify an act-as token against a resolver and the receiver's expectations.
// Never throws: any parse/crypto/policy failure becomes { ok: false, reason }
// so a boundary can always fall through to a clean deny. The signature is
// checked before any claim (aud, exp, envelope) is trusted.
export const verifyActAs = async (
  resolver: ActAsPublicKeyResolver,
  token: unknown,
  options: ActAsVerifyOptions,
): Promise<ActAsVerifyResult> => {
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

    const context = asActAsContext(jsonFromB64url(encodedPayload));
    if (!context) {
      return { ok: false, reason: "malformed" };
    }

    if (options.expectedIssuer !== undefined && context.iss !== options.expectedIssuer) {
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

    if (context.envelopeSha256 !== (await envelopeSha256(options.envelopeBytes))) {
      return { ok: false, reason: "envelope_mismatch" };
    }

    return { ok: true, context };
  } catch {
    return { ok: false, reason: "malformed" };
  }
};
