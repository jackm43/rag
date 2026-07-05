// Web Bot Auth: RFC 9421 HTTP Message Signatures for the OUTBOUND edge.
//
// This is the mirror image of the identity-context / act-as tokens. Those prove
// one internal service's identity to another over a trusted transport we own.
// This proves ragbot's identity to an origin server we DON'T own — a
// Cloudflare-fronted site that would otherwise challenge or block an unsigned
// bot. It follows the "Web Bot Auth" profile (draft-meunier-web-bot-auth-*):
// sign the target `@authority` with an Ed25519 key, tag the signature
// `web-bot-auth`, name the key by its RFC 7638 JWK Thumbprint, and publish the
// verifying key at a well-known directory the origin fetches.
//
// The crypto substrate is identical to token.ts (Ed25519 via crypto.subtle,
// base64url codec) — only the wire format differs: RFC 9421 signature bases and
// Structured-Field headers instead of a compact JWS. Key custody is unchanged:
// the private half lives in the ApplicationAuthority DO and never reaches here;
// callers hand this module an already-imported CryptoKey (or a signer closure).

import { b64urlFromBytes } from "./token";

const encoder = new TextEncoder();

const ED25519 = { name: "Ed25519" } as const;

// crypto.subtle wants an ArrayBuffer-backed view; our Uint8Arrays are always a
// full, non-shared buffer, so the cast is sound (mirrors token.ts's `buf`).
const buf = (view: Uint8Array): BufferSource => view as unknown as BufferSource;

// The signature label. RFC 9421 allows any label; the Web Bot Auth ecosystem
// conventionally uses `sig1`, and Cloudflare's verifier keys off the tag, not
// the label — but staying conventional keeps traces readable.
const SIG_LABEL = "sig1";

// The tag that marks a signature as a Web Bot Auth assertion. An origin's
// verifier selects signatures to check by this tag.
export const WEB_BOT_AUTH_TAG = "web-bot-auth";

// Default signature lifetime. Web Bot Auth signatures are meant to be short —
// they assert "this request, roughly now", not a durable capability.
export const WEB_BOT_AUTH_DEFAULT_TTL_SECONDS = 300;

// The well-known directory the origin fetches to resolve the verifying key, and
// its content type (draft-meunier-http-message-signatures-directory).
export const WEB_BOT_AUTH_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const WEB_BOT_AUTH_DIRECTORY_CONTENT_TYPE =
  "application/http-message-signatures-directory+json";

// RFC 8941 sf-binary: standard base64 (NOT base64url) with padding, so the
// Signature header value can't reuse token.ts's url-safe codec.
const b64Standard = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const bytesFromB64Standard = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

// RFC 7638 JWK Thumbprint of an OKP (Ed25519) public key, base64url-encoded.
// The thumbprint is the `keyid` in Signature-Input and the `kid` an origin
// matches against the directory — self-certifying: it is DERIVED from the key,
// not an asserted label. The canonical input contains only the required OKP
// members (crv, kty, x) in lexicographic order, with no whitespace.
export const jwkThumbprint = async (jwk: JsonWebKey): Promise<string> => {
  if (!jwk.crv || !jwk.kty || !jwk.x) {
    throw new Error("jwkThumbprint requires an OKP JWK with crv, kty, and x");
  }
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  const digest = await crypto.subtle.digest("SHA-256", buf(encoder.encode(canonical)));
  return b64urlFromBytes(new Uint8Array(digest));
};

// The `@authority` derived component (RFC 9421 §2.2.3): the lowercased authority
// (host, plus port only when non-default) of the target URI.
const authorityOf = (url: URL): string => url.host.toLowerCase();

// A covered component as [identifier, serialized-value] for the signature base.
type Component = [name: string, value: string];

// The ordered components of the Web Bot Auth profile: always `@authority`, plus
// `signature-agent` when we advertise a directory (it MUST be covered so an
// origin can't be redirected to a directory the signer didn't intend). The
// signature-agent value is an sf-string — quoted — both in the header and here.
const coveredComponents = (url: URL, signatureAgent?: string): Component[] => {
  const components: Component[] = [["@authority", authorityOf(url)]];
  if (signatureAgent) {
    components.push(["signature-agent", `"${signatureAgent}"`]);
  }
  return components;
};

// Serialize the signature parameters (the `@signature-params` value and the
// inner-list tail of Signature-Input). created/expires are sf-integers; keyid
// and tag are sf-strings.
const serializeParams = (
  components: Component[],
  created: number,
  expires: number,
  keyid: string,
): string => {
  const innerList = components.map(([name]) => `"${name}"`).join(" ");
  return `(${innerList});created=${created};expires=${expires};keyid="${keyid}";tag="${WEB_BOT_AUTH_TAG}"`;
};

// Assemble the RFC 9421 §2.5 signature base: one line per covered component,
// then the `@signature-params` line carrying the exact serialized params.
const signatureBase = (components: Component[], serializedParams: string): string =>
  [
    ...components.map(([name, value]) => `"${name}": ${value}`),
    `"@signature-params": ${serializedParams}`,
  ].join("\n");

export type WebBotAuthSignParams = {
  // Unix SECONDS (RFC 9421 uses seconds). Defaults to now.
  created?: number;
  // Signature lifetime; defaults to WEB_BOT_AUTH_DEFAULT_TTL_SECONDS.
  ttlSeconds?: number;
  // The origin serving this signer's key directory, e.g.
  // "https://ragbot.jsmunro.me". When set it is advertised in Signature-Agent
  // and folded into the covered components. Omit only if the verifier already
  // knows where to find the key (e.g. a pre-registered crawler).
  signatureAgent?: string;
};

// Sign an outbound request for the Web Bot Auth profile and return the headers
// to merge onto it. `privateKey` signs; `publicJwk` supplies the key's public
// point so we can stamp the matching RFC 7638 thumbprint as `keyid` — the same
// value an origin recomputes over the directory key to select this signature.
export const signRequest = async (
  privateKey: CryptoKey,
  publicJwk: JsonWebKey,
  request: { url: string | URL },
  params: WebBotAuthSignParams = {},
): Promise<Record<string, string>> => {
  const url = request.url instanceof URL ? request.url : new URL(String(request.url));
  const created = params.created ?? Math.floor(Date.now() / 1000);
  const expires = created + (params.ttlSeconds ?? WEB_BOT_AUTH_DEFAULT_TTL_SECONDS);
  const keyid = await jwkThumbprint(publicJwk);

  const components = coveredComponents(url, params.signatureAgent);
  const serializedParams = serializeParams(components, created, expires, keyid);
  const base = signatureBase(components, serializedParams);

  const signature = await crypto.subtle.sign(ED25519, privateKey, buf(encoder.encode(base)));

  return {
    "Signature-Input": `${SIG_LABEL}=${serializedParams}`,
    Signature: `${SIG_LABEL}=:${b64Standard(new Uint8Array(signature))}:`,
    ...(params.signatureAgent ? { "Signature-Agent": `"${params.signatureAgent}"` } : {}),
  };
};

// The verifying-key directory for publication at WEB_BOT_AUTH_DIRECTORY_PATH: a
// JWK Set whose sole key carries its own thumbprint as `kid`, so an origin can
// resolve the `keyid` from Signature-Input by exact match (or by recomputing the
// thumbprint). Feed it the authority DO's published public JWK.
export const webBotAuthDirectory = async (
  publicJwk: JsonWebKey,
): Promise<{ keys: JsonWebKey[] }> => {
  const kid = await jwkThumbprint(publicJwk);
  return {
    keys: [
      { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, kid, use: "sig", alg: "EdDSA" } as JsonWebKey,
    ],
  };
};

export type WebBotAuthVerifyFailureReason =
  | "missing_signature"
  | "malformed_signature_input"
  | "unexpected_tag"
  | "unsupported_component"
  | "expired"
  | "not_yet_valid"
  | "unknown_key"
  | "bad_signature";

export type WebBotAuthVerifyResult =
  | { ok: true; keyid: string; created?: number; expires?: number }
  | { ok: false; reason: WebBotAuthVerifyFailureReason };

// Resolve a verifying key by its `keyid` (RFC 7638 thumbprint), or null if the
// key is unknown. In production the origin (Cloudflare) is the verifier; this
// resolver lets an internal service — or the test suite — verify the profile it
// signs, closing the round-trip.
export type WebBotAuthKeyResolver = (
  keyid: string,
) => Promise<CryptoKey | null> | CryptoKey | null;

export type WebBotAuthVerifyOptions = {
  // Unix SECONDS. Defaults to now.
  now?: number;
  clockSkewSeconds?: number;
};

// Parse a single-label Signature-Input for the Web Bot Auth profile:
// `sig1=("@authority" "signature-agent");created=..;expires=..;keyid="..";tag=".."`.
// Returns the covered component names, the params, and the RAW inner-list+params
// string (the value that must appear verbatim as `@signature-params` in the
// reconstructed base — RFC 9421 signs the params as serialized, not re-derived).
const parseSignatureInput = (
  value: string,
): { label: string; components: string[]; params: Record<string, string | number>; rawParams: string } | null => {
  const match = value.trim().match(/^([A-Za-z0-9_-]+)=\(([^)]*)\)(.*)$/s);
  if (!match) {
    return null;
  }
  const [, label, inner, rest] = match;
  const components = inner.trim().length
    ? inner.trim().split(/\s+/).map((token) => token.replace(/^"|"$/g, ""))
    : [];
  const params: Record<string, string | number> = {};
  for (const part of rest.split(";")) {
    const segment = part.trim();
    if (!segment) {
      continue;
    }
    const eq = segment.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    params[key] =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : /^-?\d+$/.test(rawValue)
          ? Number(rawValue)
          : rawValue;
  }
  return { label, components, params, rawParams: `(${inner})${rest}` };
};

// Extract the sf-binary signature value (`label=:base64:`) for a label.
const parseSignature = (value: string, label: string): Uint8Array | null => {
  for (const part of value.split(",")) {
    const segment = part.trim();
    const eq = segment.indexOf("=");
    if (eq === -1 || segment.slice(0, eq) !== label) {
      continue;
    }
    const wrapped = segment.slice(eq + 1).trim();
    if (!wrapped.startsWith(":") || !wrapped.endsWith(":")) {
      return null;
    }
    return bytesFromB64Standard(wrapped.slice(1, -1));
  }
  return null;
};

// Verify a Web Bot Auth signature over a request. Reconstructs the RFC 9421
// signature base from the request `@authority`, the received `Signature-Agent`
// header (when covered), and the verbatim signed params, then checks the
// Ed25519 signature and the created/expires window. Only the Web Bot Auth
// covered components are supported; any other component is refused rather than
// silently ignored.
export const verifyRequest = async (
  resolveKey: WebBotAuthKeyResolver,
  request: { url: string | URL; headers: Headers },
  options: WebBotAuthVerifyOptions = {},
): Promise<WebBotAuthVerifyResult> => {
  const signatureInput = request.headers.get("signature-input");
  const signatureHeader = request.headers.get("signature");
  if (!signatureInput || !signatureHeader) {
    return { ok: false, reason: "missing_signature" };
  }

  const parsed = parseSignatureInput(signatureInput);
  if (!parsed) {
    return { ok: false, reason: "malformed_signature_input" };
  }
  if (parsed.params.tag !== WEB_BOT_AUTH_TAG) {
    return { ok: false, reason: "unexpected_tag" };
  }
  const keyid = parsed.params.keyid;
  if (typeof keyid !== "string") {
    return { ok: false, reason: "malformed_signature_input" };
  }

  const url = request.url instanceof URL ? request.url : new URL(String(request.url));
  const componentLines: string[] = [];
  for (const name of parsed.components) {
    if (name === "@authority") {
      componentLines.push(`"@authority": ${authorityOf(url)}`);
    } else if (name === "signature-agent") {
      const agent = request.headers.get("signature-agent");
      if (agent === null) {
        return { ok: false, reason: "malformed_signature_input" };
      }
      componentLines.push(`"signature-agent": ${agent.trim()}`);
    } else {
      return { ok: false, reason: "unsupported_component" };
    }
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 0;
  const { created, expires } = parsed.params;
  if (typeof expires === "number" && now > expires + skew) {
    return { ok: false, reason: "expired" };
  }
  if (typeof created === "number" && now + skew < created) {
    return { ok: false, reason: "not_yet_valid" };
  }

  const key = await resolveKey(keyid);
  if (!key) {
    return { ok: false, reason: "unknown_key" };
  }

  const signature = parseSignature(signatureHeader, parsed.label);
  if (!signature) {
    return { ok: false, reason: "malformed_signature_input" };
  }

  const base = [...componentLines, `"@signature-params": ${parsed.rawParams}`].join("\n");
  const valid = await crypto.subtle.verify(ED25519, key, buf(signature), buf(encoder.encode(base)));
  if (!valid) {
    return { ok: false, reason: "bad_signature" };
  }

  return {
    ok: true,
    keyid,
    ...(typeof created === "number" ? { created } : {}),
    ...(typeof expires === "number" ? { expires } : {}),
  };
};
