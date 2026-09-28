// Test-only stand-in for AI Gateway's OpenAI Responses endpoint. It plays a
// scripted coding agent: the first turn asks Codex to run a shell command that
// writes an app, later turns reply with a summary. Every request is recorded so
// tests can assert what reached the "gateway" (model, headers, credentials).
import http from "node:http";
import { appendFileSync } from "node:fs";

export const APP_SCRIPT = String.raw`set -e
mkdir -p src test
cat > index.html <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Spinning Cube Party</title>
  </head>
  <body>
    <canvas id="scene" aria-label="Spinning cube"></canvas>
    <p id="who" role="status">Connecting…</p>
    <p>Taps: <output id="taps">0</output></p>
    <button id="tap" type="button">Tap together</button>
    <ul id="peers"></ul>
    <script type="module" src="./src/main.js"></script>
  </body>
</html>
HTML
cat > src/count.js <<'JS'
export const increment = (state) => ({ ...state, taps: (state?.taps ?? 0) + 1 });
JS
cat > src/main.js <<'JS'
import * as THREE from "three";
import { getMe, joinRoom } from "./ragbot.js";
import { increment } from "./count.js";
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(320, 240, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
camera.position.z = 3;
const cube = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial());
scene.add(cube);
renderer.setAnimationLoop(() => { cube.rotation.x += 0.01; cube.rotation.y += 0.02; renderer.render(scene, camera); });
const me = await getMe();
document.getElementById("who").textContent = "Signed in as " + me.name;
const room = joinRoom("party", {
  onState: (state) => { document.getElementById("taps").textContent = String(state?.taps ?? 0); },
  onPeers: (peers) => {
    document.getElementById("peers").replaceChildren(...peers.map((p) => Object.assign(document.createElement("li"), { textContent: p.name })));
  },
});
document.getElementById("tap").addEventListener("click", () => room.setState(increment));
JS
cat > test/count.test.js <<'JS'
import assert from "node:assert/strict";
import { test } from "node:test";
import { increment } from "../src/count.js";
test("increments from empty state", () => assert.equal(increment(null).taps, 1));
JS
npm install three
npm run build
npm test`;

// A later revision: proves the previous source was restored before the change.
export const CHANGE_SCRIPT = String.raw`set -e
test -f src/count.js
node -e 'const fs = require("fs"); fs.writeFileSync("index.html", fs.readFileSync("index.html", "utf8").replace("Spinning Cube Party</title>", "Spinning Cube Party v2</title>"))'
npm run build`;

const SUMMARY =
  "Built Spinning Cube Party: a three.js cube with a shared tap counter. Everyone in the server sees the same count and who is online.";

let sequence = 0;

function events(output) {
  const id = `resp_${++sequence}`;
  const list = [
    {
      type: "response.created",
      response: { id, status: "in_progress", output: [] },
    },
  ];
  output.forEach((item, index) => {
    list.push({
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, status: "in_progress" },
    });
    if (item.type === "message")
      list.push({
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: item.content[0].text,
      });
    list.push({ type: "response.output_item.done", output_index: index, item });
  });
  list.push({
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    },
  });
  return list;
}

export function reply(body) {
  const script = JSON.stringify(body.input ?? []).includes("<change>")
    ? CHANGE_SCRIPT
    : APP_SCRIPT;
  const called = (body.input ?? []).some(
    (item) => item.type === "function_call_output",
  );
  const tools = (body.tools ?? []).map((tool) => tool.name ?? tool.type);
  if (!called) {
    const shell = tools.find((name) =>
      ["exec_command", "shell_command", "shell"].includes(name),
    );
    const args =
      shell === "exec_command"
        ? { cmd: script, yield_time_ms: 240000 }
        : shell === "shell_command"
          ? { command: script, timeout_ms: 240000 }
          : { command: ["bash", "-lc", script], timeout_ms: 240000 };
    return events([
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: shell,
        arguments: JSON.stringify(args),
        status: "completed",
      },
    ]);
  }
  return events([
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: SUMMARY, annotations: [] }],
    },
  ]);
}

export function start(port, log) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = JSON.parse(text || "{}");
    } catch {}
    if (log)
      appendFileSync(
        log,
        JSON.stringify({
          method: request.method,
          url: request.url,
          headers: request.headers,
          model: body.model,
          tools: (body.tools ?? []).map((tool) => tool.name ?? tool.type),
          output: (body.input ?? [])
            .filter((item) => item.type === "function_call_output")
            .map((item) => String(item.output).slice(-1500)),
        }) + "\n",
      );
    if (request.method !== "POST" || !/\/responses$/.test(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of reply(body))
      response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    response.end();
  });
  return new Promise((resolve) =>
    server.listen(port, "0.0.0.0", () => resolve(server)),
  );
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
)
  await start(Number(process.env.PORT ?? 9090), process.env.MODEL_LOG);
