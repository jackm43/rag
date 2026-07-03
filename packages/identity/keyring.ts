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
