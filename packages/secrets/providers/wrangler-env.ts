import type { SecretsEnv as Env } from "../env";
import type { SecretsProvider } from "../types";

// wrangler-env: reads a secret from env by binding name. This is today's
// behaviour and the DEFAULT backend — a `wrangler secret put NAME` (or a plain
// var) lands on env[NAME]. Resolving returns that value, or null when the
// binding is unprovisioned or empty (fail closed).
//
// There is no runtime `set`: worker vars/secrets are provisioning-time, written
// via `wrangler secret put`, not from within a request.
export const wranglerEnvProvider = (env: Env): SecretsProvider => ({
  get: async (ref) => {
    const value = (env as unknown as Record<string, unknown>)[ref];
    return typeof value === "string" && value.length > 0 ? value : null;
  },
});
