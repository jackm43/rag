import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { ecThumbprint } from "../packages/boundaries/inbound/dpop";
import { createDpopSigner } from "../packages/devproxy-client/index";
import { ensureHome, keyPath } from "./config";

// Local DPoP key management. ragctl holds an ES256 (P-256) keypair — the same
// shape the dev-proxy browser page mints (workers/public/dev-proxy/src/page.ts)
// and the worker verifies (packages/boundaries/inbound/dpop.ts). The public
// key's RFC 7638 thumbprint (jkt) sender-constrains the session; the private key
// signs a fresh proof per request.
//
// Persistence trade-off: because every `ragctl` invocation is a new process, the
// key cannot be an in-memory non-extractable key like the browser's — it must be
// stored so proofs are stable across runs. We store it as a JWK under a 0600
// file in the 0700 home. When loaded back for signing, the PRIVATE half is
// imported non-extractable, so it cannot be re-exported from the running process
// (the on-disk JWK is the only copy, protected by file permissions). The private
// key is never logged or printed by any command.

type PublicEcJwk = { kty: "EC"; crv: string; x: string; y: string };

type StoredKey = {
  version: 1;
  createdAt: string;
  jkt: string;
  publicJwk: PublicEcJwk;
  // Full private JWK (carries the `d` component). Secret — never printed.
  privateJwk: JsonWebKey;
};

const ES256_KEY = { name: "ECDSA", namedCurve: "P-256" } as const;

const requirePublicJwk = (jwk: JsonWebKey): PublicEcJwk => {
  if (jwk.kty !== "EC" || typeof jwk.crv !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("exported public key is not a P-256 EC JWK");
  }
  return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
};

const readStoredKey = (): StoredKey => {
  const path = keyPath();
  if (!existsSync(path)) {
    throw new Error(`no DPoP key found at ${path} — run \`ragctl keys generate\` first`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as StoredKey;
};

export type GenerateResult = { created: boolean; jkt: string; path: string };

// Generate + persist a fresh keypair. Refuses to clobber an existing key unless
// `force` is set, because overwriting rotates the jkt and abandons any session
// bound to the old key.
export const generateKey = async (force: boolean): Promise<GenerateResult> => {
  ensureHome();
  const path = keyPath();
  if (existsSync(path) && !force) {
    const existing = readStoredKey();
    return { created: false, jkt: existing.jkt, path };
  }

  const keyPair = (await crypto.subtle.generateKey(ES256_KEY, true, ["sign", "verify"])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicJwk = requirePublicJwk(await crypto.subtle.exportKey("jwk", keyPair.publicKey));
  const jkt = await ecThumbprint(publicJwk);

  const stored: StoredKey = {
    version: 1,
    createdAt: new Date().toISOString(),
    jkt,
    publicJwk,
    privateJwk,
  };
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies mode when creating the file; chmod covers the
  // overwrite (--force) case too.
  chmodSync(path, 0o600);

  return { created: true, jkt, path };
};

export type PublicKeyInfo = { jkt: string; createdAt: string; publicJwk: PublicEcJwk; path: string };

// The public, non-secret view of the stored key for `ragctl keys show`.
export const showKey = (): PublicKeyInfo => {
  const stored = readStoredKey();
  return { jkt: stored.jkt, createdAt: stored.createdAt, publicJwk: stored.publicJwk, path: keyPath() };
};

export type LoadedSigner = {
  // A `dpopProof(htm, htu)` hook ready to hand to createDevProxyClient.
  signer: (htm: string, htu: string) => Promise<string>;
  jkt: string;
};

// Load the stored key and build a DPoP proof signer from it. The private key is
// imported non-extractable; the public key is imported extractable because
// createDpopSigner re-exports it into each proof's JWK header.
export const loadSigner = async (): Promise<LoadedSigner> => {
  const stored = readStoredKey();
  const privateKey = await crypto.subtle.importKey("jwk", stored.privateJwk, ES256_KEY, false, ["sign"]);
  const publicKey = await crypto.subtle.importKey("jwk", stored.publicJwk, ES256_KEY, true, ["verify"]);
  const keyPair = { privateKey, publicKey } as CryptoKeyPair;
  return { signer: createDpopSigner(keyPair), jkt: stored.jkt };
};
