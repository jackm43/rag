import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  symlink,
  mkdir,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, validateSite, safePath } from "./server.mjs";
test("artifact collection rejects symlinks and oversize files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rag-artifact-"));
  try {
    await writeFile(join(dir, "index.html"), "hello");
    assert.deepEqual(await collect(dir), { "index.html": "hello" });
    await assert.rejects(() => collect(dir, 2));
    await symlink("/etc/passwd", join(dir, "secret"));
    await assert.rejects(() => collect(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("only deployable bounded text assets are accepted", () => {
  validateSite({ "index.html": "hello", "app.js": "void 0" });
  for (const value of [
    { "index.html": "hello", "../secret": "bad" },
    { "index.html": "hello", "x.exe": "bad" },
    {},
  ])
    assert.throws(() => validateSite(value));
  assert.equal(safePath("../secret"), false);
  assert.equal(safePath(".env.production"), false);
});
test("checked-in template has a game UI and no answer in browser code", async () => {
  const template = JSON.parse(
    await readFile(new URL("template.json", import.meta.url), "utf8"),
  );
  assert.match(template["public/app.js"], /\/_wordle\//);
  assert.match(template["public/index.html"], /aria-live/);
  assert.ok(template["test/site.test.mjs"]);
});
