import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./workers/public/gateway/src/index.ts",
      remoteBindings: false,
      wrangler: { configPath: "./workers/public/gateway/wrangler.jsonc" },
      // The gateway now binds ServiceRegistry as an EXTERNAL Durable Object
      // (script_name: ragbot-registry-worker). Provide a stub of that worker so
      // miniflare can resolve the binding. register() is a no-op and snapshot()
      // returns an empty manifest list, so registryEntities() yields [] and
      // authorization falls back to the static Cedar bootstrap permits — the
      // same behaviour tests already rely on (no test pre-registers a manifest).
      miniflare: {
        workers: [
          {
            name: "ragbot-registry-worker",
            modules: true,
            compatibilityDate: "2026-04-23",
            compatibilityFlags: ["nodejs_compat"],
            script: [
              'import { DurableObject } from "cloudflare:workers";',
              "export class ServiceRegistry extends DurableObject {",
              "  async register() {}",
              "  async snapshot() { return new Uint8Array(); }",
              "}",
              'export default { fetch() { return new Response("Not found", { status: 404 }); } };',
            ].join("\n"),
            durableObjects: { SERVICE_REGISTRY: "ServiceRegistry" },
          },
        ],
      },
    }),
  ],
});
