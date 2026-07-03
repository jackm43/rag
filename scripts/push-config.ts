import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export { };

// Uploads every file in packages/ai/ai-config into the workflows worker's AI_CONFIG
// KV namespace. Key scheme: the file's basename (e.g. "discord-response.json",
// "discord-response-system-prompt.md") — the same keys loadConfig reads. The
// bundled copies stay in the repo as the fallback + source of truth. Run after
// deploy (deploy.sh does this) or standalone to publish a prompt edit without a
// redeploy — new isolates pick up the new value.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const configDir = join(repoRoot, "packages/ai/ai-config");
const workflowsConfig = join(repoRoot, "workers/services/workflows/wrangler.jsonc");

const files = readdirSync(configDir).filter((name) => !name.startsWith("."));
if (files.length === 0) {
  throw new Error(`No config files found in ${configDir}`);
}

for (const file of files) {
  const path = join(configDir, file);
  console.info(`Uploading ${file} -> AI_CONFIG[${file}]`);
  execFileSync(
    "wrangler",
    [
      "kv",
      "key",
      "put",
      file,
      "--path",
      path,
      "--binding",
      "AI_CONFIG",
      "--config",
      workflowsConfig,
      "--remote",
    ],
    { stdio: "inherit" },
  );
}

console.info(`Pushed ${files.length} config file(s) to AI_CONFIG.`);
