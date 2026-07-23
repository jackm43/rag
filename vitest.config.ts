import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Parsed at config time and handed to the test worker as a plain binding; the
  // per-file setup applies them to the isolated D1 instance before each suite.
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        remoteBindings: false,
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
