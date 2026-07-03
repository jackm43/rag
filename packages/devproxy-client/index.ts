import type { components } from "./api-types";

// Typed client for the ragbot dev-proxy HTTP API, for out-of-worker consumers
// such as ragctl. It is deliberately a "dumb" web client (matching the client-
// library design pattern): it owns no key material and no Access token — the
// caller supplies both through middleware hooks, so credential handling stays
// where the secrets live. The request/response shapes come from the OpenAPI
// contract's generated types (api-types.ts, `npm run devproxy:types`), so the
// client cannot drift from the worker's ingress.

export type CommandRequest = components["schemas"]["CommandRequest"];

export type DevProxyClientOptions = {
  // Base URL of the dev-proxy, e.g. "https://ragbot-dev.jsmunro.me".
  baseUrl: string;
  // Returns a DPoP proof JWS bound to (htm, htu) for the outgoing request.
  // Required — the dev-proxy refuses any request without a valid proof.
  dpopProof: (htm: string, htu: string) => string | Promise<string>;
  // Returns the Cloudflare Access application token for the
  // Cf-Access-Jwt-Assertion header. Optional: when the caller runs behind
  // `cloudflared access` (which injects the token) it may be omitted.
  accessToken?: () => string | Promise<string>;
  // Injectable fetch (tests / non-global environments).
  fetch?: typeof fetch;
};

export type DevProxyResponse = {
  status: number;
  body: unknown;
};

export type DevProxyClient = {
  command: (request: CommandRequest) => Promise<DevProxyResponse>;
};

export const createDevProxyClient = (options: DevProxyClientOptions): DevProxyClient => {
  const doFetch = options.fetch ?? fetch;
  return {
    command: async (request) => {
      const htu = new URL("/api/command", options.baseUrl).toString();
      const headers: Record<string, string> = {
        "content-type": "application/json",
        DPoP: await options.dpopProof("POST", htu),
      };
      if (options.accessToken) {
        headers["Cf-Access-Jwt-Assertion"] = await options.accessToken();
      }
      const response = await doFetch(htu, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
  };
};

// --- DPoP signer hook -------------------------------------------------------

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlJson = (value: unknown): string => b64url(encoder.encode(JSON.stringify(value)));

// Build a `dpopProof` hook from a WebCrypto P-256 key pair (as produced by
// crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, …, ["sign"])).
// Each call signs a fresh proof with a random jti and the current time — so
// every request is single-use and replay-protected end to end. Works anywhere
// WebCrypto is available (workers, Node ≥ 20, browsers).
export const createDpopSigner = (
  keyPair: CryptoKeyPair,
): ((htm: string, htu: string) => Promise<string>) => {
  return async (htm, htu) => {
    const pub = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as {
      crv: string;
      x: string;
      y: string;
    };
    const header = {
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: { kty: "EC", crv: pub.crv, x: pub.x, y: pub.y },
    };
    const payload = {
      htm,
      htu,
      jti: crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000),
    };
    const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      encoder.encode(signingInput),
    );
    return `${signingInput}.${b64url(new Uint8Array(signature))}`;
  };
};
