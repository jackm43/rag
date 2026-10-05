import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The React app is the client build; worker/index.ts runs in workerd in dev and is deployed with it.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), cloudflare({ configPath: "./wrangler.jsonc" })],
});
