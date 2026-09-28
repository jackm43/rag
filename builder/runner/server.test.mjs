import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { bundleServer, manifest, SERVER_EVENTS, titleOf } from "./server.mjs";

async function dist(files) {
  const root = await mkdtemp(path.join(tmpdir(), "ragbot-dist-"));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  return root;
}

test("lists publishable build output", async () => {
  const root = await dist({
    "index.html": "<title>x</title>",
    "assets/app-1.js": "1",
    "models/ship.glb": Buffer.from([0, 1, 2]),
  });
  try {
    assert.deepEqual(await manifest(root), [
      { path: "assets/app-1.js", size: 1 },
      { path: "index.html", size: 16 },
      { path: "models/ship.glb", size: 3 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses output the host would not serve", async () => {
  for (const files of [
    { "app.js": "no index" },
    { "index.html": "x", ".env": "SECRET=1" },
    { "index.html": "x", "_api/rooms/x": "shadow" },
    { "index.html": "x", "bad name.js": "x" },
  ]) {
    const root = await dist(files);
    try {
      await assert.rejects(
        () => manifest(root),
        JSON.stringify(Object.keys(files)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const root = await dist({ "index.html": "x" });
  try {
    await symlink("/etc/passwd", path.join(root, "passwd.txt"));
    await assert.rejects(() => manifest(root), /Not a regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a dist/ that links outside the app", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ragbot-app-"));
  try {
    await symlink("/etc", path.join(root, "dist"));
    await assert.rejects(
      () => manifest(path.join(root, "dist")),
      /must be a directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function app(files) {
  const root = await dist(files);
  // The bundler runs as the agent user (uid 1000) when tests run as root.
  if (process.getuid?.() === 0) spawnSync("chown", ["-R", "1000:1000", root]);
  return root;
}

test("bundles optional server logic with its imports", async () => {
  const root = await app({
    "server/room.js":
      'import { score } from "../src/rules.js";\nexport function message(room, peer, data) { room.state = { score: score(data) }; }\nexport function join() {}',
    "src/rules.js": "export const score = (n) => n * 2;",
  });
  try {
    const bytes = await bundleServer(root, path.join(root, "out"));
    const code = bytes.toString("utf8");
    assert.match(code, /n \* 2/);
    assert.match(code, /export\s*\{/);
    assert.equal(
      await bundleServer(await dist({}), path.join(root, "none")),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects server logic the host cannot run", async () => {
  for (const [code, pattern] of [
    [
      "export function message() {}\nexport const secret = 1;",
      /also exports secret/,
    ],
    ["export const message = ;", /did not bundle/],
    ["const x = 1;", /may only export/],
  ]) {
    const root = await app({ "server/room.js": code });
    try {
      await assert.rejects(
        () => bundleServer(root, path.join(root, "out")),
        pattern,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("reads the page title for Discord and the hub", () => {
  assert.equal(
    titleOf("<html><title> Tom &amp; Jerry&#39;s </title>"),
    "Tom & Jerry's",
  );
  assert.equal(titleOf("<h1>none</h1>"), "");
});

test("the template's platform contract matches the host", async () => {
  const sdk = await readFile(
    new URL("../template/src/ragbot.js", import.meta.url),
    "utf8",
  );
  const agents = await readFile(
    new URL("../template/AGENTS.md", import.meta.url),
    "utf8",
  );
  assert.match(sdk, /_api\/rooms\//);
  assert.match(sdk, /_api\/me/);
  assert.match(sdk, /this\.server = Boolean\(message\.server\)/);
  for (const event of SERVER_EVENTS)
    assert.match(agents, new RegExp(`export function ${event}\\(`));
  assert.match(agents, /never\s+`\/logo\.png`/);
  const vite = await readFile(
    new URL("../template/vite.config.js", import.meta.url),
    "utf8",
  );
  assert.match(vite, /base: "\.\/"/);
});
