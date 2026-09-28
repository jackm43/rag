// Runs as the unprivileged agent user. Codex talks to AI Gateway's OpenAI
// endpoint with a placeholder key; the host's outbound handler replaces it, so
// nothing in this container can spend or leak a real credential.
import { Codex } from "@openai/codex-sdk";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleServer, manifest, run } from "./server.mjs";

const job = JSON.parse(await readFile(process.env.RAGBOT_JOB, "utf8"));
const app = process.env.RAGBOT_APP;

function prompt({ request, change }) {
  if (!change)
    return `A member of our Discord server asked for a web app:

<request>
${request}
</request>

Build it in the current directory, following AGENTS.md. The starter files are placeholders: replace them with the real app.`;
  return `The current directory contains a web app you built for our Discord server from this request:

<request>
${request}
</request>

A member has asked for a change:

<change>
${change}
</change>

Make the change following AGENTS.md and keep everything else working.`;
}

/** The same checks the host runs after the agent exits; null when they pass. */
async function check() {
  for (const script of ["build", "test"]) {
    const result = await run("npm", ["run", script], {
      timeout: 300000,
      cwd: app,
    });
    if (result.code)
      return `\`npm run ${script}\` failed:\n\n${result.output.slice(-6000)}`;
  }
  try {
    await manifest(path.join(app, "dist"));
  } catch (error) {
    return `The build output cannot be published: ${error.message}`;
  }
  try {
    await bundleServer(app, path.join(path.dirname(app), "server-check"));
  } catch (error) {
    return error.message;
  }
  return null;
}

const codex = new Codex({
  // Cloudflare's documented Codex setup: a Responses-API provider at the gateway.
  config: {
    model_provider: "cloudflare-ai-gateway",
    model_providers: {
      "cloudflare-ai-gateway": {
        name: "Cloudflare AI Gateway",
        base_url: job.gateway,
        env_key: "RAGBOT_GATEWAY_KEY",
        wire_api: "responses",
      },
    },
  },
  env: { ...process.env, RAGBOT_GATEWAY_KEY: "replaced-by-host" },
});
const thread = codex.startThread({
  model: job.model,
  modelReasoningEffort: job.effort || undefined,
  workingDirectory: app,
  skipGitRepoCheck: true,
  // The container is the sandbox; Codex's own Linux sandbox cannot run in it.
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  networkAccessEnabled: true,
  webSearchMode: "disabled",
});

let turn = await thread.run(prompt(job));
for (let attempt = 0; attempt < 2; attempt++) {
  const failure = await check();
  if (!failure) break;
  turn = await thread.run(
    `The platform checks failed.\n\n${failure}\n\nFix the problem so that \`npm run build\` and \`npm test\` pass and dist/ can be published, then reply with the summary for Discord again.`,
  );
}
await writeFile(
  process.env.RAGBOT_RESULT,
  JSON.stringify({ summary: turn.finalResponse }),
);
