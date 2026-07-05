// The secrets-provider module: the seam through which the credential broker
// resolves every provider credential. `secretsProvider(env, name)` selects a
// backend by name; `resolveSecretRef(env, ref)` is the convenience that resolves
// a whole {provider, ref}. Backends fail closed (missing/unreachable -> null),
// so a connector op denies rather than surfacing a half-resolved credential.
// See AGENTS.md (connectors section) for the {provider, ref} shape; the four
// backends live in ./providers.
import type { SecretsEnv as Env } from "./env";
import { cloudflareSecretStoreProvider } from "./providers/cloudflare-secret-store";
import { hashicorpVaultProvider } from "./providers/hashicorp-vault";
import { onepasswordProvider } from "./providers/onepassword";
import { wranglerEnvProvider } from "./providers/wrangler-env";
import type { SecretRef, SecretsProvider } from "./types";

export type { SecretRef, SecretsProvider } from "./types";

// The four backends, in the order the admin surface lists them. This is the
// single source of truth for "which backends exist"; describeSecretsProviders
// maps each to its runtime capability.
export const SECRETS_PROVIDER_NAMES = [
  "wrangler-env",
  "cloudflare-secret-store",
  "hashicorp-vault",
  "onepassword",
] as const;

// A backend's runtime capability, for the connectors admin surface (never a
// secret value). `writable` is whether the backend supports a runtime `set` (it
// exposes the `set` method); `configured` is whether it has the env/binding it
// needs to operate at all. The UI disables a non-writable backend for value
// entry and warns when one is unconfigured.
export type SecretsProviderInfo = { name: string; writable: boolean; configured: boolean };

export const describeSecretsProviders = (env: Env): SecretsProviderInfo[] =>
  SECRETS_PROVIDER_NAMES.map((name) => {
    const provider = secretsProvider(env, name);
    return {
      name,
      writable: typeof provider.set === "function",
      // Absent `configured` means "always configured" — the wrangler-env default,
      // which is just `env` and needs no address/token/binding.
      configured: provider.configured ? provider.configured() : true,
    };
  });

// Select a secrets backend by name. An unknown name falls back to wrangler-env
// (today's behaviour) so a connector with no explicit backend keeps reading
// worker secrets — the safe default, not a failure.
export const secretsProvider = (env: Env, name: string): SecretsProvider => {
  switch (name) {
    case "cloudflare-secret-store":
      return cloudflareSecretStoreProvider(env);
    case "hashicorp-vault":
      return hashicorpVaultProvider(env);
    case "onepassword":
      return onepasswordProvider(env);
    case "wrangler-env":
    default:
      return wranglerEnvProvider(env);
  }
};

// Resolve a whole SecretRef via its provider. Returns null (fail closed) when
// the reference cannot be resolved; callers turn null into a denial.
export const resolveSecretRef = (env: Env, ref: SecretRef): Promise<string | null> =>
  secretsProvider(env, ref.provider).get(ref.ref);
