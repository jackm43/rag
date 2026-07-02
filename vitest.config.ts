import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./workers/public/gateway/src/index.ts",
      remoteBindings: false,
      wrangler: { configPath: "./workers/public/gateway/wrangler.jsonc" },
    }),
  ],
});
