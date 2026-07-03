import type { MachinePrincipal } from "../auth/principal";
import { importVerifyingKey, type PublicKeyResolver } from "./token";

// Static public keyring: machine principal -> Ed25519 public JWK. Public keys
// are NOT secret, so they are committed here and read by every verifier to
// resolve an issuer's key. The matching private signing keys live in per-
// worker secrets (e.g. GATEWAY_SIGNING_KEY) — see the README "Identity
// exchange" section and scripts/generate-keys.ts.
//
// Rotation: generate a new keypair with `tsx scripts/generate-keys.ts <worker>`,
// deploy the new private key to the worker's secret, then update the public
// JWK here. Because tokens are short-lived (60s) and verified per hop, a
// key rotation only needs the old and new public keys to coexist here for the
// length of one deploy window; to support that, `PUBLIC_KEYRING` values may be
// widened to an array of JWKs and the resolver taught to try each — kept as a
// single key per worker for now since rotation is manual and rare.
export const PUBLIC_KEYRING: Record<MachinePrincipal, JsonWebKey> = {
  gateway: {
    kty: "OKP",
    crv: "Ed25519",
    x: "WLBRy5_x-U27lYp3QoCm3dg4NzmMAIBT8w6oODf7-Og",
  },
  brain: {
    kty: "OKP",
    crv: "Ed25519",
    x: "CpovGn_wbuSw6KN94Cisarey69JrMAvJx55YtCpSBpE",
  },
  responder: {
    kty: "OKP",
    crv: "Ed25519",
    x: "Lnp9NNeP_35T7f1Mw0hTpJmnuMfnppbfkt3ToVwroGc",
  },
  spend: {
    kty: "OKP",
    crv: "Ed25519",
    x: "RHa6T_vqdx5v_bttgMzenwtdLII_Ud6_aP5CB6h7BSk",
  },
  // The dev-proxy worker's public verifying key. Its private half lives in the
  // DEV_PROXY_SIGNING_KEY secret on workers/public/dev-proxy; the gateway's
  // DevProxy entrypoint resolves this key to verify dev-proxy hops.
  "dev-proxy": {
    kty: "OKP",
    crv: "Ed25519",
    x: "v60E6h2mWbtpW9KMMQdUhSOXVWjrJEzK6WDz1aaIfWU",
  },
  // The credential broker's verifying key. The broker is a VERIFY-ONLY receiver
  // — it never signs an outbound service hop (its egress is provider HTTP, not a
  // service call) — so this key's private half is not held anywhere in
  // production and this entry is present only to keep the keyring exhaustive
  // over MachinePrincipal. If the broker ever needs to call another service, a
  // real CONNECTORS_SIGNING_KEY secret would be provisioned and this key used to
  // verify its hops.
  connectors: {
    kty: "OKP",
    crv: "Ed25519",
    x: "tlvX0YnwjSma94r5lPNsnwn6FwXTxJy8x6R2ph55mho",
  },
};

// Imported CryptoKeys are cached per isolate: import is async and pure, and the
// keyring never changes at runtime.
const keyCache = new Map<string, CryptoKey>();

// Resolver over the committed keyring; unknown issuers resolve to null so the
// verifier denies with "unknown_issuer".
export const keyringResolver: PublicKeyResolver = async (iss) => {
  const cached = keyCache.get(iss);
  if (cached) {
    return cached;
  }
  const jwk = PUBLIC_KEYRING[iss as MachinePrincipal];
  if (!jwk) {
    return null;
  }
  const key = await importVerifyingKey(jwk);
  keyCache.set(iss, key);
  return key;
};

// The committed PUBLIC_KEYRING above is the development/default keyring — its
// private halves live in test/helpers.ts so the suite can sign and verify
// against it. PRODUCTION supplies the real public keys (whose private halves are
// in per-worker signing-key secrets, never the repo) as a JSON map via the
// SERVICE_PUBLIC_KEYS var — public keys are not secret. A verifier prefers the
// env keyring and falls back to the committed default, so a token signed by a
// real private key only verifies where the matching real public key is
// configured; a missing/garbled var fails closed to the committed keys (a
// key mismatch is a denial, never a bypass).
export type ServicePublicKeysEnv = { SERVICE_PUBLIC_KEYS?: string };

const parseEnvKeyring = (raw: string | undefined): Record<string, JsonWebKey> => {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, JsonWebKey>) : {};
  } catch {
    return {};
  }
};

export const resolverFromEnv = (env?: ServicePublicKeysEnv): PublicKeyResolver => {
  const override = parseEnvKeyring(env?.SERVICE_PUBLIC_KEYS);
  const cache = new Map<string, CryptoKey>();
  return async (iss) => {
    const cached = cache.get(iss);
    if (cached) {
      return cached;
    }
    const jwk = override[iss] ?? PUBLIC_KEYRING[iss as MachinePrincipal];
    if (!jwk) {
      return null;
    }
    const key = await importVerifyingKey(jwk);
    cache.set(iss, key);
    return key;
  };
};
