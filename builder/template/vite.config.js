import { defineConfig } from "vite";

// Apps are served under /<app-name>/, so every URL in the build must be relative.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4096 },
});
