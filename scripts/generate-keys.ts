export {};

// Generates an Ed25519 signing keypair for one worker's identity-context
// tokens. Prints the public JWK (paste into packages/identity/keyring.ts) and
// the private JWK (store as the worker's signing-key secret, never committed):
//
//   tsx scripts/generate-keys.ts brain
//   wrangler secret put BRAIN_SIGNING_KEY -c workers/services/brain/wrangler.jsonc
//     (paste the printed private JWK JSON when prompted)
//
// The public/private keys are an Ed25519 pair; only the private JWK is a
// secret. See the README "Identity exchange" section for the per-worker secret
// names and provisioning steps.

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
};

const WORKERS = ["gateway", "brain", "responder", "spend"] as const;
type Worker = (typeof WORKERS)[number];

const SECRET_NAMES: Record<Worker, string> = {
  gateway: "GATEWAY_SIGNING_KEY",
  brain: "BRAIN_SIGNING_KEY",
  responder: "RESPONDER_SIGNING_KEY",
  spend: "SPEND_SIGNING_KEY",
};

const worker = process.argv[2] as Worker | undefined;
if (!worker || !WORKERS.includes(worker)) {
  throw new Error(`usage: tsx scripts/generate-keys.ts <${WORKERS.join("|")}>`);
}

const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;

const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

// eslint-disable-next-line no-console
console.log(`\n# ${worker} public JWK — commit to packages/identity/keyring.ts (PUBLIC_KEYRING.${worker}):`);
// eslint-disable-next-line no-console
// Emit only kty/crv/x: workerd's importKey rejects an OKP JWK carrying
// alg:"Ed25519", so the keyring stores the bare public point.
console.log(JSON.stringify({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x }));
// eslint-disable-next-line no-console
console.log(`\n# ${worker} private JWK — set as the ${SECRET_NAMES[worker]} secret (do NOT commit):`);
// eslint-disable-next-line no-console
console.log(JSON.stringify(privateJwk));
