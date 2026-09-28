import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          APP_ORIGIN: "https://apps.test",
          ALLOWED_GUILD_IDS: "457689460096630794",
          DISCORD_CLIENT_ID: "test-client",
          DISCORD_CLIENT_SECRET: "test-secret",
          CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          AI_GATEWAY_ID: "test-gateway",
          CF_AIG_TOKEN: "test-aig-token",
          CODING_MODEL: "gpt-5.5",
          CODING_REASONING_EFFORT: "medium",
        },
        durableObjects: {
          PROJECTS: { className: "Project", useSQLite: true },
          AUTH: { className: "Auth", useSQLite: true },
          ROOMS: { className: "Rooms", useSQLite: true },
          DIRECTORY: { className: "Directory", useSQLite: true },
          RUNNERS: { className: "FakeRunner", useSQLite: true },
        },
        r2Buckets: ["ARTIFACTS"],
        workerLoaders: { LOADER: {} },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30000 },
});
