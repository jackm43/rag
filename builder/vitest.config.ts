import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          APP_DOMAIN: "apps.test",
          AUTH_ORIGIN: "https://login.apps.test",
          ALLOWED_GUILD_IDS: "457689460096630794",
          DISCORD_CLIENT_ID: "test-client",
          DISCORD_CLIENT_SECRET: "test-secret",
          DISCORD_BOT_TOKEN: "test-bot",
          GITHUB_REPOSITORY: "test/repo",
          GITHUB_BASE_BRANCH: "main",
          GITHUB_TOKEN: "test-token",
        },
        durableObjects: {
          PROJECTS: { className: "Project" },
          AUTH: { className: "Auth" },
          ROOMS: { className: "Room" },
          RUNNERS: { className: "FakeRunner" },
        },
        r2Buckets: ["ARTIFACTS"],
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30000 },
});
