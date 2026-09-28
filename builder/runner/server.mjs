// Build supervisor. Runs as root inside the container; the coding agent and
// everything it starts run as the unprivileged `agent` user. The Worker drives
// it over HTTP: PUT /source (optional seed), POST /start, GET /status, then
// GET /file/<path> and GET /source to publish. No credentials exist here.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chown,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = process.env.RAGBOT_TEMPLATE ?? "/opt/template";
const WORK = process.env.RAGBOT_WORK ?? "/workspace";
const APP = path.join(WORK, "app");
const SEED = path.join(WORK, "seed.tar.gz");
const JOB = path.join(WORK, "job.json");
const RESULT = path.join(WORK, "result.json");
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const AGENT_UID = 1000;
const PLATFORM_FILES = ["AGENTS.md", "src/ragbot.js"];

export const LIMITS = {
  files: 400,
  file: 10 * 1024 * 1024,
  total: 25 * 1024 * 1024,
  source: 20 * 1024 * 1024,
};
const segment = /^[A-Za-z0-9_@+~-][A-Za-z0-9._@+~-]*$/;

/** List a build output directory, rejecting anything the host would refuse to publish. */
export async function manifest(root) {
  // The output directory itself must be a real directory, not a link elsewhere.
  const expected = path.join(
    await realpath(path.dirname(root)),
    path.basename(root),
  );
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== expected)
    throw new Error("dist/ must be a directory");
  const files = [];
  let total = 0;
  async function walk(dir, prefix) {
    for (const name of (await readdir(dir)).sort()) {
      const relative = prefix + name;
      if (!segment.test(name))
        throw new Error(`Unsupported file name: ${relative}`);
      const info = await lstat(path.join(dir, name));
      if (info.isDirectory()) await walk(path.join(dir, name), relative + "/");
      else if (!info.isFile())
        throw new Error(`Not a regular file: ${relative}`);
      else {
        if (info.size > LIMITS.file)
          throw new Error(`File over 10 MiB: ${relative}`);
        total += info.size;
        files.push({ path: relative, size: info.size });
      }
    }
  }
  await walk(root, "");
  if (!files.some((file) => file.path === "index.html"))
    throw new Error("dist/index.html is missing");
  if (files.some((file) => file.path.split("/")[0] === "_api"))
    throw new Error("dist/_api is reserved");
  if (files.length > LIMITS.files)
    throw new Error(`More than ${LIMITS.files} files in dist/`);
  if (total > LIMITS.total) throw new Error("dist/ is larger than 25 MiB");
  return files;
}

export function titleOf(html) {
  const match = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return match
    ? match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim()
    : "";
}

const asAgent =
  process.getuid?.() === 0 ? { uid: AGENT_UID, gid: AGENT_UID } : {};

export function agentEnv(extra = {}) {
  const ca = existsSync(CA)
    ? { NODE_EXTRA_CA_CERTS: CA, CODEX_CA_CERTIFICATE: CA, SSL_CERT_FILE: CA }
    : {};
  return {
    PATH: process.env.PATH,
    HOME: process.env.RAGBOT_HOME ?? "/home/agent",
    CI: "true",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_prefer_offline: "true",
    ...ca,
    ...extra,
  };
}

/** Run a command as the agent user; resolves with its exit code and output tail. */
export function run(command, args, { timeout, cwd = APP, env = {} }) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, {
      cwd,
      env: agentEnv(env),
      detached: true,
      ...asAgent,
    });
    const collect = (chunk) => (output = (output + chunk).slice(-16384));
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      output += `\n[timed out after ${timeout / 1000}s]`;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeout);
    child.on("error", () => resolve({ code: -1, output }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

/** Stop anything the agent left running, so published files cannot change underneath us. */
async function killAgentProcesses() {
  if (!asAgent.uid) return;
  for (const pid of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(
      () => "",
    );
    if (new RegExp(`^Uid:\\s+${AGENT_UID}\\s`, "m").test(status))
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
  }
}

// Runs as root: hands a tree we prepared over to the agent.
function giveToAgent(dir) {
  if (!asAgent.uid) return Promise.resolve();
  return new Promise((resolve, reject) =>
    spawn("chown", ["-R", `${AGENT_UID}:${AGENT_UID}`, dir]).on(
      "close",
      (code) => (code === 0 ? resolve() : reject(new Error("setup_failed"))),
    ),
  );
}

let state = { phase: "idle" };
let current = null;
let output = null;

async function prepare(job) {
  await rm(APP, { recursive: true, force: true });
  await cp(TEMPLATE, APP, { recursive: true, verbatimSymlinks: true });
  await giveToAgent(WORK);
  if (!job.seeded) return;
  const extract = await run(
    "tar",
    ["-xzf", SEED, "-C", APP, "--no-same-owner"],
    { timeout: 120000 },
  );
  if (extract.code) throw new Error("source_invalid");
  // Earlier revisions cannot pin an old copy of the platform contract. Copied
  // as the agent, since the restored tree is agent-controlled.
  for (const file of PLATFORM_FILES) {
    const copied = await run(
      "sh",
      [
        "-c",
        'mkdir -p "$(dirname "$2")" && cp "$1" "$2"',
        "copy",
        path.join(TEMPLATE, file),
        file,
      ],
      { timeout: 10000 },
    );
    if (copied.code) throw new Error("source_invalid");
  }
  const install = await run("npm", ["install"], { timeout: 600000 });
  if (install.code) throw new Error("install_failed");
}

async function execute(job) {
  try {
    state = { phase: "building" };
    await prepare(job);
    await writeFile(JOB, JSON.stringify(job));
    await rm(RESULT, { force: true });
    const agent = await run(
      "node",
      [path.join(path.dirname(fileURLToPath(import.meta.url)), "agent.mjs")],
      {
        timeout: 35 * 60000,
        env: { RAGBOT_JOB: JOB, RAGBOT_APP: APP, RAGBOT_RESULT: RESULT },
      },
    );
    await killAgentProcesses();
    if (agent.code) throw new Error("agent_failed");
    state = { phase: "checking" };
    for (const [script, error] of [
      ["build", "build_failed"],
      ["test", "tests_failed"],
    ]) {
      const result = await run("npm", ["run", script], { timeout: 300000 });
      await killAgentProcesses();
      if (result.code) throw new Error(error);
    }
    let files;
    try {
      files = await manifest(path.join(APP, "dist"));
    } catch {
      throw new Error("invalid_output");
    }
    const source = await tarball();
    const contents = new Map();
    for (const file of files) {
      const bytes = await readFile(path.join(APP, "dist", file.path));
      if (bytes.length !== file.size) throw new Error("invalid_output");
      contents.set(file.path, bytes);
    }
    const result = JSON.parse(await readFile(RESULT, "utf8").catch(() => "{}"));
    output = { contents, source };
    state = {
      phase: "done",
      summary:
        typeof result.summary === "string"
          ? result.summary.trim().slice(0, 1500)
          : "",
      title: titleOf(contents.get("index.html").toString("utf8")).slice(0, 80),
      files,
    };
  } catch (error) {
    state = {
      phase: "failed",
      error: String(error.message || "build_failed").slice(0, 40),
    };
  }
}

// Archive the source (not dependencies or output) for the next revision.
function tarball() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const child = spawn(
      "tar",
      [
        "-czf",
        "-",
        "--exclude=./node_modules",
        "--exclude=./dist",
        "--exclude=./.git",
        "-C",
        APP,
        ".",
      ],
      { ...asAgent },
    );
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > LIMITS.source) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("close", (code) =>
      code === 0 && size <= LIMITS.source
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("source_too_large")),
    );
  });
}

async function body(request, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new Error("too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function server() {
  return http.createServer(async (request, response) => {
    const send = (status, value, type = "application/json") => {
      response.writeHead(status, { "content-type": type });
      response.end(type === "application/json" ? JSON.stringify(value) : value);
    };
    try {
      const url = new URL(request.url, "http://runner");
      if (request.method === "GET" && url.pathname === "/status")
        return send(200, state);
      if (request.method === "PUT" && url.pathname === "/source") {
        if (current) return send(409, { error: "busy" });
        await mkdir(WORK, { recursive: true });
        await writeFile(SEED, await body(request, LIMITS.source));
        return send(200, {});
      }
      if (request.method === "POST" && url.pathname === "/start") {
        const job = JSON.parse(await body(request, 64 * 1024));
        if (typeof job.id !== "string" || typeof job.request !== "string")
          return send(400, {});
        if (current) return send(current === job.id ? 200 : 409, {});
        current = job.id;
        void execute(job);
        return send(202, {});
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/file/") &&
        output
      ) {
        const file = output.contents.get(
          decodeURIComponent(url.pathname.slice(6)),
        );
        return file
          ? send(200, file, "application/octet-stream")
          : send(404, {});
      }
      if (request.method === "GET" && url.pathname === "/source" && output)
        return send(200, output.source, "application/gzip");
      return send(404, {});
    } catch {
      return send(400, {});
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(WORK, { recursive: true });
  if (asAgent.uid) await chown(WORK, AGENT_UID, AGENT_UID);
  server().listen(8080, "0.0.0.0");
}
