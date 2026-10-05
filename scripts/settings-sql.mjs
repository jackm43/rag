// Write .wrangler/settings.sql, which creates the AI settings row from config/ai unless one exists.
// `pnpm run settings:init --local|--remote` runs it through `wrangler d1 execute`.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const directory = new URL("../config/ai/", import.meta.url);
const resources = Object.fromEntries(
  readdirSync(directory)
    .filter((name) => /\.(json|md)$/.test(name))
    .sort()
    .map((name) => [name, readFileSync(new URL(name, directory), "utf8")]),
);
for (const [name, text] of Object.entries(resources)) if (name.endsWith(".json")) JSON.parse(text);

const revision = crypto.randomUUID().replaceAll("-", "");
const document = JSON.stringify({ schemaVersion: 2, revision, updatedAt: new Date().toISOString(), resources });
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const sql = `INSERT INTO ai_runtime_settings (id, revision, document) VALUES (1, ${quote(revision)}, ${quote(document)}) ON CONFLICT(id) DO NOTHING;\n`;

mkdirSync(new URL("../.wrangler/", import.meta.url), { recursive: true });
writeFileSync(new URL("../.wrangler/settings.sql", import.meta.url), sql);
