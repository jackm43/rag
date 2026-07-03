import type { Env } from "../../contracts/types";
import { errorMessage, logger } from "../../logger";
import type { SecretsProvider } from "../types";

// cloudflare-secret-store: reads from a Cloudflare Secrets Store binding
// (SECRETS_STORE), which centralizes rotation and account-scoped access control.
// The binding resolves a secret by name asynchronously; a missing binding, an
// unknown name, or a read error all resolve to null (fail closed) so a
// misconfigured store denies the connector op rather than half-resolving.
//
// No `set`: Secrets Store writes are an account-management operation, not a
// per-request runtime write, so a future UI would provision through the control
// plane rather than this read binding.
export const cloudflareSecretStoreProvider = (env: Env): SecretsProvider => ({
  get: async (ref) => {
    const store = env.SECRETS_STORE;
    if (!store) {
      return null;
    }
    try {
      const value = await store.get(ref);
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch (error) {
      logger.warn("secret_store_read_failed", { error: errorMessage(error) });
      return null;
    }
  },
  // The read binding is present, but there is no runtime `set` (see above): the
  // admin surface reports this backend as non-writable and tells the operator the
  // exact secret name to provision through the Cloudflare control plane.
  configured: () => Boolean(env.SECRETS_STORE),
});
