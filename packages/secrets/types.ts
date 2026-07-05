// The pluggable secrets-provider abstraction. The credential broker resolves
// EVERY provider credential through this seam: a connector's registry entry
// carries a {provider, ref} secret reference rather than a hardcoded env binding
// name, and the strategy calls secretsProvider(env, ref.provider).get(ref.ref).
// Moving a credential between backends (a worker secret, Cloudflare Secrets
// Store, HashiCorp Vault, 1Password) is then a config change, not a code change.

// A secret reference: which backend resolves it, and the backend-specific
// locator within that backend.
export type SecretRef = {
  // The provider backend name (see secretsProvider): "wrangler-env",
  // "cloudflare-secret-store", "hashicorp-vault", or "onepassword".
  provider: string;
  // The locator within that backend:
  //   wrangler-env            — an env binding name (e.g. "GITHUB_APP_PRIVATE_KEY")
  //   cloudflare-secret-store — a Secrets Store secret name
  //   hashicorp-vault         — a KV v2 "<mount>/<path>#<field>" locator
  //   onepassword             — an "op://<vault>/<item>/<field>" reference
  ref: string;
};

// A pluggable secrets backend. `get` resolves a reference to its plaintext
// value, or null when it is absent/unreachable — providers FAIL CLOSED so a
// missing or broken backend denies the connector op rather than surfacing a
// half-resolved credential. `set` is optional: a backend that can only be
// written out-of-band (deploy-time worker secrets, control-plane Secrets Store)
// omits it, and the presence of `set` IS the runtime write-capability the admin
// surface reports. `configured` reports whether the backend has the env it needs
// to operate at all (address + token, a binding); absent means "always
// configured" (the wrangler-env default, which is just `env`).
export type SecretsProvider = {
  get: (ref: string) => Promise<string | null>;
  set?: (ref: string, value: string) => Promise<void>;
  configured?: () => boolean;
};
