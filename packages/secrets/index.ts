// The secrets-provider module: the seam through which the credential broker
// resolves every provider credential. `secretsProvider(env, name)` selects a
// backend by name; `resolveSecretRef(env, ref)` is the convenience that resolves
// a whole {provider, ref}. Backends fail closed (missing/unreachable -> null),
// so a connector op denies rather than surfacing a half-resolved credential.
// See CONNECTORS.md for the {provider, ref} shape and the four backends.
import type { Env } from "../contracts/types";
import { cloudflareSecretStoreProvider } from "./providers/cloudflare-secret-store";
import { hashicorpVaultProvider } from "./providers/hashicorp-vault";
import { onepasswordProvider } from "./providers/onepassword";
import { wranglerEnvProvider } from "./providers/wrangler-env";
import type { SecretRef, SecretsProvider } from "./types";

export type { SecretRef, SecretsProvider } from "./types";

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
