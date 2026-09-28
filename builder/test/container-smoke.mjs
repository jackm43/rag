// Test-only local provider. Never copied into the production image.
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const message = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [
    { type: "output_text", text: "The starter app is ready.", annotations: [] },
  ],
};
const provider = http.createServer(async (req, res) => {
  for await (const _ of req) {
  }
  if (req.url !== "/v1/responses") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    {
      type: "response.created",
      response: { id: "resp_test", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: "The starter app is ready.",
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text: "The starter app is ready.",
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ];
  for (const e of events)
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
});
await new Promise((r) => provider.listen(9090, "127.0.0.1", r));
const child = spawn("node", ["/opt/runner/server.mjs"], {
  env: {
    ...process.env,
    CODEX_MODEL: "gpt-6-sol",
    CODEX_BASE_URL: "http://127.0.0.1:9090/v1",
  },
  stdio: "inherit",
});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8080/status");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready);
  const input = {
    id: "a".repeat(32) + "-1",
    kind: "site",
    model: "gpt-6-sol",
    prompt: "Use the existing starter as-is.",
    instructions: "Do not change files; finish immediately.",
  };
  assert(
    (
      await fetch("http://127.0.0.1:8080/start", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).ok,
  );
  let result;
  for (let i = 0; i < 300; i++) {
    result = await (await fetch("http://127.0.0.1:8080/status")).json();
    if (["complete", "failed"].includes(result.status)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(result.status, "complete", JSON.stringify(result));
  assert(result.artifact.files["index.html"]);
  assert.deepEqual(result.artifact.tests, ["node --test"]);
  console.log(
    "Container smoke passed: real Codex binary, mocked Responses API, unprivileged runner, tests, artifact collection.",
  );
} finally {
  child.kill("SIGTERM");
  provider.close();
}
