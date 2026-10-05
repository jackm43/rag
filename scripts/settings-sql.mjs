// Write .wrangler/settings.sql, which creates the AI settings row from config/ai unless one exists.
// `pnpm run settings:init --local|--remote` runs it through `wrangler d1 execute`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseSettings } from "../src/settings.ts";

const read = (name) => readFileSync(new URL(`../config/ai/${name}`, import.meta.url), "utf8");
const { chat, image } = JSON.parse(read("settings.json"));
const revision = crypto.randomUUID().replaceAll("-", "");
const settings = parseSettings({
  schemaVersion: 3,
  revision,
  updatedAt: new Date().toISOString(),
  chat: { ...chat, prompt: read("chat-system-prompt.md") },
  image,
});

const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const sql = `INSERT INTO ai_runtime_settings (id, revision, document) VALUES (1, ${quote(revision)}, ${quote(JSON.stringify(settings))}) ON CONFLICT(id) DO NOTHING;\n`;

mkdirSync(new URL("../.wrangler/", import.meta.url), { recursive: true });
writeFileSync(new URL("../.wrangler/settings.sql", import.meta.url), sql);
