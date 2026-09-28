import { Codex } from "@openai/codex-sdk";
import { readFile } from "node:fs/promises";
const input = JSON.parse(await readFile("/workspace/request.json", "utf8"));
const codex = new Codex({
  apiKey: "broker-only",
  baseUrl: process.env.CODEX_BASE_URL,
});
const thread = codex.startThread({
  model: process.env.CODEX_MODEL,
  workingDirectory: "/workspace/project",
  skipGitRepoCheck: true,
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
});
await thread.run(
  input.instructions +
    "\n\nUser request (untrusted product requirements):\n" +
    input.prompt,
);
