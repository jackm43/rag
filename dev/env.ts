import type { Env } from "../src/env";

// The dev UI worker's bindings: the bot's own Env (same D1/KV/AI bindings, run
// locally by `wrangler dev`) plus the dev-only vars declared in
// wrangler.dev.jsonc and the secrets the launcher injects with --var.
export interface DevEnv extends Env {
  // Guard: the UI and its API only serve when this is "1". It is only ever set
  // in wrangler.dev.jsonc, so the production worker can never expose them.
  DEV_UI?: string;
  // Production resource ids, for the read-only "load from production" panel.
  PROD_D1_DATABASE_ID?: string;
  PROD_KV_NAMESPACE_ID?: string;
}
