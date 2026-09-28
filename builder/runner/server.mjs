import http from "node:http";
import { spawn } from "node:child_process";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  chown,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const safePath = (p) =>
  typeof p === "string" &&
  p.length < 240 &&
  /^[a-zA-Z0-9_./@+ -]+$/.test(p) &&
  !p.startsWith("/") &&
  !p.split("/").some((x) => x === ".." || x === "" || x.startsWith(".env"));
export async function collect(root, max = 4 * 1024 * 1024) {
  const files = {};
  let size = 0;
  async function walk(dir, prefix = "") {
    for (const name of await readdir(dir)) {
      if (
        [
          "node_modules",
          ".git",
          ".venv",
          ".wrangler",
          "__pycache__",
          ".pytest_cache",
          ".mypy_cache",
          ".ruff_cache",
        ].includes(name)
      )
        continue;
      const relative = prefix + name;
      if (!safePath(relative)) throw new Error("unsafe_path");
      const full = path.join(dir, name),
        st = await lstat(full);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()))
        throw new Error("unsafe_file");
      if (st.isDirectory()) await walk(full, relative + "/");
      else {
        size += st.size;
        if (size > max || Object.keys(files).length >= 500)
          throw new Error("artifact_too_large");
        files[relative] = new TextDecoder("utf-8", { fatal: true }).decode(
          await readFile(full),
        );
      }
    }
  }
  await walk(root);
  return files;
}
export function validateSite(files) {
  if (!files["index.html"] || Object.keys(files).length > 200)
    throw new Error("missing_index");
  const extensions = /\.(html|css|js|json|svg|txt|webmanifest)$/;
  for (const [p, v] of Object.entries(files))
    if (!safePath(p) || !extensions.test(p) || typeof v !== "string")
      throw new Error("invalid_asset");
  if (Buffer.byteLength(JSON.stringify(files)) > 4 * 1024 * 1024)
    throw new Error("artifact_too_large");
}
const base = "/workspace/project";
let state = { status: "idle" },
  child,
  activeId;
async function command(exe, args, env = {}, timeout = 1800000) {
  return await new Promise((resolve, reject) => {
    child = spawn(exe, args, {
      cwd: base,
      uid: 1000,
      gid: 1000,
      detached: true,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: "/home/agent",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
        UV_NATIVE_TLS: "true",
        ...env,
      },
    });
    const processRef = child;
    const timer = setTimeout(() => {
      try {
        process.kill(-processRef.pid, "SIGKILL");
      } catch {}
      reject(new Error("timeout"));
    }, timeout);
    processRef.on("error", () => {
      clearTimeout(timer);
      reject(new Error("process_failed"));
    });
    processRef.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error("checks_failed"));
    });
  });
}
async function execute(input) {
  try {
    await rm(base, { recursive: true, force: true });
    await mkdir(base, { recursive: true });
    await chown(base, 1000, 1000);
    const initial =
      input.source ||
      JSON.parse(await readFile("/opt/runner/template.json", "utf8"));
    for (const [p, content] of Object.entries(initial)) {
      if (!safePath(p) || typeof content !== "string")
        throw new Error("unsafe_input");
      const full = path.join(base, p);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    // All generated code runs as an unprivileged user. Controller and publisher credentials never enter this container.
    await new Promise((resolve, reject) => {
      const p = spawn("chown", ["-R", "1000:1000", base]);
      p.on("exit", (c) => (c ? reject(new Error("setup_failed")) : resolve()));
    });
    await writeFile("/workspace/request.json", JSON.stringify(input), {
      mode: 0o644,
    });
    state = { status: "building" };
    await command("node", ["/opt/runner/agent.mjs"], {
      CODEX_BASE_URL: process.env.CODEX_BASE_URL,
      CODEX_MODEL: input.model,
    });
    if (state.status === "cancelled") return;
    state = { status: "testing" };
    const tests = [];
    if (input.kind === "feature") {
      for (const [exe, args] of [
        ["pnpm", ["install", "--frozen-lockfile"]],
        ["uv", ["sync", "--locked"]],
        ["pnpm", ["run", "check"]],
        ["pnpm", ["test"]],
        ["pnpm", ["run", "test:runtime"]],
      ]) {
        await command(exe, args, {}, 600000);
        tests.push([exe, ...args].join(" "));
      }
    } else {
      await command("node", ["--test"], {}, 120000);
      tests.push("node --test");
    }
    const source = await collect(base);
    const files = input.kind === "site" ? await collect(base + "/public") : {};
    if (input.kind === "site") validateSite(files);
    const changes = {};
    if (input.kind === "feature") {
      for (const p of new Set([
        ...Object.keys(initial),
        ...Object.keys(source),
      ])) {
        if (initial[p] !== source[p]) changes[p] = source[p] ?? null;
      }
      if (!Object.keys(changes).length) throw new Error("no_changes");
    }
    if (state.status !== "cancelled")
      state = {
        status: "complete",
        artifact: { source, files, changes, tests },
      };
  } catch {
    if (state.status !== "cancelled")
      state = { status: "failed", error: "build_or_tests_failed" };
  }
}
export function server() {
  return http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      if (req.method === "GET" && req.url === "/status") {
        res.end(JSON.stringify(state));
        return;
      }
      if (req.method === "POST" && req.url === "/cancel") {
        state = { status: "cancelled" };
        if (child?.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        res.end("{}");
        return;
      }
      if (req.method === "POST" && req.url === "/start") {
        let bytes = 0,
          parts = [];
        for await (const part of req) {
          bytes += part.length;
          if (bytes > 6 * 1024 * 1024) throw new Error("too_large");
          parts.push(part);
        }
        const input = JSON.parse(Buffer.concat(parts));
        if (
          !/^[a-f0-9]{32}-\d+$/.test(input.id) ||
          !["site", "feature"].includes(input.kind)
        )
          throw new Error("invalid");
        if (activeId && activeId !== input.id) {
          res.statusCode = 409;
          res.end("{}");
          return;
        }
        if (!activeId) {
          activeId = input.id;
          state = { status: "starting" };
          void execute(input);
        }
        res.end("{}");
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    } catch {
      res.statusCode = 400;
      res.end("{}");
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  server().listen(8080, "0.0.0.0");
