import { guardDenial, type InboundGuard } from "./guard";
import { errorMessage, logger } from "@rag/logger";
import type { IngressEnv as Env } from "./env";

// Cloudflare Access application-token verification (the first ingress gate of
// the dev-proxy worker). Access sits in front of the worker and, once a user
// has authenticated with the team's IdP, forwards the request carrying a signed
// JWT (the "application token") in the `Cf-Access-Jwt-Assertion` header (and a
// `CF_Authorization` cookie). Access itself is a network gate; this module is
// the cryptographic proof that the request genuinely passed through it and
// carries a real, unexpired identity for THIS Access application.
//
// The verification is intentionally standalone (no JWT dependency): Access
// signs with RS256 (RSA, the default) or ES256 (EC P-256), both of which
// workerd's WebCrypto verifies natively. The pure verifier below takes an
// injected key resolver and clock so it is exhaustively testable; the guard
// wraps it with a TTL-cached JWKS fetch against the team's certs endpoint.
//
// Fail closed everywhere: a missing/oversized token, an unknown kid, a bad
// signature, or any claim mismatch (iss, aud, exp, nbf) is a denial, and the
// verifier never throws to its caller.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Access tokens are compact; cap the input so a hostile caller cannot force
// large base64 decodes before we reject.
const MAX_ACCESS_TOKEN_LENGTH = 8192;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // Access rotates keys ~6-weekly.

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const ES256_IMPORT = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256_VERIFY = { name: "ECDSA", hash: "SHA-256" } as const;
const SUPPORTED_ALGS = new Set(["RS256", "ES256"]);

const buf = (view: Uint8Array): BufferSource => view as unknown as BufferSource;

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

export type AccessIdentity = {
  // The Access subject: a stable user id for the authenticated identity.
  sub: string;
  // The user's email as asserted by Access, when present.
  email?: string;
};

export type AccessVerifyFailure =
  | "malformed"
  | "unsupported_alg"
  | "unknown_kid"
  | "bad_signature"
  | "iss_mismatch"
  | "aud_mismatch"
  | "expired"
  | "not_yet_valid";

export type AccessVerifyResult =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; reason: AccessVerifyFailure };

// Resolves a verifying key for a token header's (kid, alg). Returns null for an
// unknown kid so the verifier denies rather than throwing.
export type AccessKeyResolver = (
  kid: string,
  alg: string,
) => CryptoKey | null | Promise<CryptoKey | null>;

export type AccessVerifyOptions = {
  // The team issuer, e.g. "https://myteam.cloudflareaccess.com".
  expectedIss: string;
  // The Access application AUD tag the token must be addressed to.
  expectedAud: string;
  now?: number;
  clockSkewSeconds?: number;
};

const audienceMatches = (aud: unknown, expected: string): boolean =>
  typeof aud === "string" ? aud === expected : Array.isArray(aud) && aud.includes(expected);

type AccessClaims = {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  email?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
};

// Verify a Cloudflare Access application token. The signature is checked before
// any claim is trusted; only then are iss/aud/exp/nbf evaluated.
export const verifyAccessJwt = async (
  token: unknown,
  options: AccessVerifyOptions,
  resolver: AccessKeyResolver,
): Promise<AccessVerifyResult> => {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_ACCESS_TOKEN_LENGTH) {
      return { ok: false, reason: "malformed" };
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "malformed" };
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const header = jsonFromB64url(encodedHeader) as { alg?: unknown; kid?: unknown };
    const alg = header?.alg;
    const kid = header?.kid;
    if (typeof alg !== "string" || !SUPPORTED_ALGS.has(alg) || typeof kid !== "string") {
      return { ok: false, reason: "unsupported_alg" };
    }

    const key = await resolver(kid, alg);
    if (!key) {
      return { ok: false, reason: "unknown_kid" };
    }

    const signatureValid = await crypto.subtle.verify(
      alg === "ES256" ? ES256_VERIFY : RS256,
      key,
      buf(bytesFromB64url(encodedSignature)),
      buf(encoder.encode(`${encodedHeader}.${encodedPayload}`)),
    );
    if (!signatureValid) {
      return { ok: false, reason: "bad_signature" };
    }

    const claims = jsonFromB64url(encodedPayload) as AccessClaims;
    if (claims.iss !== options.expectedIss) {
      return { ok: false, reason: "iss_mismatch" };
    }
    if (!audienceMatches(claims.aud, options.expectedAud)) {
      return { ok: false, reason: "aud_mismatch" };
    }

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    if (typeof claims.exp !== "number" || now > claims.exp + skew) {
      return { ok: false, reason: "expired" };
    }
    const notBefore = typeof claims.nbf === "number" ? claims.nbf : claims.iat;
    if (typeof notBefore === "number" && now + skew < notBefore) {
      return { ok: false, reason: "not_yet_valid" };
    }

    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      // A valid Access token always carries a subject; its absence is malformed.
      return { ok: false, reason: "malformed" };
    }

    return {
      ok: true,
      identity: {
        sub: claims.sub,
        ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      },
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
};

// --- JWKS fetch + cache + guard ---------------------------------------------

type Jwk = JsonWebKey & { kid?: string; alg?: string };
type CachedKeys = { at: number; keys: Map<string, CryptoKey> };

const jwksCache = new Map<string, CachedKeys>();

const importJwk = (jwk: Jwk): Promise<CryptoKey> =>
  jwk.kty === "EC"
    ? crypto.subtle.importKey("jwk", jwk, ES256_IMPORT, false, ["verify"])
    : crypto.subtle.importKey("jwk", jwk, RS256, false, ["verify"]);

// Fetch and cache the team's JWKS. Keyed by team domain; a stale cache is served
// on fetch failure if one exists, otherwise the resolver returns null (deny).
const jwksResolver = (teamDomain: string): AccessKeyResolver => {
  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  return async (kid) => {
    const cached = jwksCache.get(teamDomain);
    if (cached && Date.now() - cached.at < JWKS_CACHE_TTL_MS) {
      return cached.keys.get(kid) ?? null;
    }
    try {
      const response = await fetch(certsUrl);
      if (!response.ok) {
        throw new Error(`certs ${response.status}`);
      }
      const body = (await response.json()) as { keys?: Jwk[] };
      const keys = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        if (typeof jwk.kid === "string") {
          keys.set(jwk.kid, await importJwk(jwk));
        }
      }
      jwksCache.set(teamDomain, { at: Date.now(), keys });
      return keys.get(kid) ?? null;
    } catch (error) {
      logger.warn("cf_access_jwks_fetch_failed", { teamDomain, error: errorMessage(error) });
      // Serve stale keys on a transient fetch failure; otherwise deny.
      return cached?.keys.get(kid) ?? null;
    }
  };
};

// The Access header Cloudflare adds after a user authenticates; the cookie is
// the fallback for same-origin browser navigations.
const ACCESS_HEADER = "cf-access-jwt-assertion";
const ACCESS_COOKIE = "CF_Authorization";

const accessTokenFromRequest = (request: Request): string | null => {
  const header = request.headers.get(ACCESS_HEADER);
  if (header) {
    return header;
  }
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ACCESS_COOKIE) {
      return rest.join("=");
    }
  }
  return null;
};

export type AccessPrincipal = {
  principal: "cf-access";
  identity: AccessIdentity;
};

// Ingress guard: verifies the Access token against the team JWKS. Fails closed
// (401) when the team domain or audience is unconfigured, so the worker cannot
// run without an Access application in front of it.
export const cloudflareAccessGuard: InboundGuard<AccessPrincipal> = {
  identity: "cf-access",
  verify: async (request, env: Env) => {
    const unauthorized = () => new Response("Unauthorized", { status: 401 });
    const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
    const aud = env.CF_ACCESS_AUD;
    if (!teamDomain || !aud) {
      return guardDenial(cloudflareAccessGuard, "access_unconfigured", unauthorized());
    }
    const token = accessTokenFromRequest(request);
    if (!token) {
      return guardDenial(cloudflareAccessGuard, "access_token_missing", unauthorized());
    }
    const result = await verifyAccessJwt(
      token,
      { expectedIss: `https://${teamDomain}`, expectedAud: aud },
      jwksResolver(teamDomain),
    );
    if (!result.ok) {
      return guardDenial(cloudflareAccessGuard, `access_${result.reason}`, unauthorized());
    }
    return { ok: true, grant: { principal: "cf-access", identity: result.identity } };
  },
};

// Test seam: clears the per-isolate JWKS cache.
export const resetAccessJwksCache = () => jwksCache.clear();
