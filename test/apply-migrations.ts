import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// vitest-pool-workers isolates D1 per test file; apply the real migration set to
// each suite's DB before its tests run. TEST_MIGRATIONS is injected by
// vitest.config.ts (readD1Migrations over ./migrations).
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
