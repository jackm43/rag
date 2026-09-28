import { readFile, writeFile } from "node:fs/promises";
const files = {
  "public/index.html": await readFile(
    new URL("../templates/site/index.html", import.meta.url),
    "utf8",
  ),
  "public/app.js": await readFile(
    new URL("../templates/site/app.js", import.meta.url),
    "utf8",
  ),
  "package.json": JSON.stringify({
    name: "guild-app",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }),
  "test/site.test.mjs": `import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';test('ships an accessible entry page and local script',async()=>{const html=await readFile('public/index.html','utf8');assert.match(html,/<title>.+<\\/title>/);assert.match(html,/viewport/);const js=await readFile('public/app.js','utf8');assert.ok(js.length>0)});`,
};
await writeFile(
  new URL("template.json", import.meta.url),
  JSON.stringify(files, null, 2) + "\n",
);
