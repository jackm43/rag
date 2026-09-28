// Runs inside the real build image with networking disabled:
//   docker run --rm --network none -v "$PWD/builder/test:/test:ro" IMAGE node /test/container-smoke.mjs
// The real Codex binary drives the supervisor against a scripted local model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { start } from "./fake-model.mjs";

const log = path.join(
  await mkdtemp(path.join(tmpdir(), "model-")),
  "requests.jsonl",
);
const model = await start(9090, log);
const runner = spawn("node", ["/opt/runner/server.mjs"], { stdio: "inherit" });
const base = "http://127.0.0.1:8080";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(phase) {
  for (let i = 0; i < 900; i++) {
    const state = await (await fetch(base + "/status")).json();
    if (["done", "failed"].includes(state.phase)) {
      assert.equal(state.phase, phase, JSON.stringify(state));
      return state;
    }
    await wait(200);
  }
  throw new Error("timed out");
}

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/status")).ok) break;
    } catch {}
    await wait(100);
  }
  const job = {
    id: "a".repeat(32) + ":1",
    request: "a three.js cube we can tap together",
    gateway: "http://127.0.0.1:9090/v1/account/gateway/openai",
    model: "gpt-5.5",
    effort: "medium",
  };
  assert.equal(
    (
      await fetch(base + "/start", {
        method: "POST",
        body: JSON.stringify(job),
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await fetch(base + "/start", {
        method: "POST",
        body: JSON.stringify(job),
      })
    ).status,
    200,
  );
  const state = await until("done");
  assert.equal(state.title, "Spinning Cube Party");
  assert.match(state.summary, /three\.js cube/);
  const paths = state.files.map((file) => file.path);
  assert.ok(paths.includes("index.html"));
  const script = paths.find((p) => /^assets\/.*\.js$/.test(p));
  const bundle = await (await fetch(`${base}/file/${script}`)).text();
  assert.match(
    bundle,
    /WebGLRenderer|three/i,
    "three.js was installed and bundled",
  );
  const html = await (await fetch(base + "/file/index.html")).text();
  assert.match(html, /src="\.\/assets\//, "asset URLs are relative");
  const source = Buffer.from(
    await (await fetch(base + "/source")).arrayBuffer(),
  );
  assert.ok(
    source.length > 100 && source[0] === 0x1f && source[1] === 0x8b,
    "gzip source archive",
  );

  const requests = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(requests.length >= 2);
  for (const request of requests) {
    assert.equal(request.url, "/v1/account/gateway/openai/responses");
    assert.equal(request.model, "gpt-5.5");
    assert.equal(request.headers.authorization, "Bearer replaced-by-host");
  }
  console.log(
    `Container smoke passed: Codex ${requests.length} model turns, tools [${requests[0].tools.join(", ")}], ` +
      `${state.files.length} files published, three.js bundled, source archived.`,
  );
} finally {
  runner.kill("SIGTERM");
  model.close();
}
