// Local end-to-end test of the builder: real Worker and Durable Objects under
// `wrangler dev`, the real build image in Docker with Cloudflare's egress
// interception, the real Codex binary, and real browsers. Only AI Gateway and
// Discord are replaced by local fakes (see e2e-worker.ts). Nothing leaves the
// machine except npm registry traffic from the build container.
//
//   pnpm --dir builder e2e
//
// Needs Docker and permission to bind port 443. Optional: E2E_BUILD_CA (CA
// bundle for TLS-intercepting build proxies), E2E_CHROMIUM (browser binary),
// E2E_OUT (screenshot directory).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { GUILD, USERS, start as startDiscord } from "./fake-discord.mjs";
import { start as startModel } from "./fake-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://apps.test";
const IMAGE = "ragbot-builder:e2e";
const MODEL_PORT = 19090;
const DISCORD_PORT = 19091;
const CONSENT_PORT = 19443;
const work = mkdtempSync(path.join(tmpdir(), "ragbot-e2e-"));
const out = process.env.E2E_OUT ?? path.join(work, "screenshots");
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`\n▶ ${text}`);

// --- infrastructure ---------------------------------------------------------

step("Building the container image");
const secret = process.env.E2E_BUILD_CA
  ? ["--secret", `id=ca,src=${process.env.E2E_BUILD_CA}`]
  : [];
const built = spawnSync(
  "docker",
  ["build", "-q", ...secret, "-t", IMAGE, ROOT],
  { stdio: "inherit", env: { ...process.env, DOCKER_BUILDKIT: "1" } },
);
assert.equal(built.status, 0, "docker build failed");

const modelLog = path.join(work, "model.jsonl");
const model = await startModel(MODEL_PORT, modelLog);
// Browsers reach "discord.com" at a local consent page with a throwaway cert.
const tlsFiles = ["key.pem", "cert.pem"].map((name) => path.join(work, name));
const openssl = spawnSync("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-days",
  "1",
  "-subj",
  "/CN=discord.com",
  "-keyout",
  tlsFiles[0],
  "-out",
  tlsFiles[1],
]);
assert.equal(openssl.status, 0, "openssl is required");
const discord = await startDiscord(DISCORD_PORT, {
  clientId: "e2e-client",
  clientSecret: "e2e-secret",
  redirectUri: `${ORIGIN}/_auth/callback`,
  tls: { key: readFileSync(tlsFiles[0]), cert: readFileSync(tlsFiles[1]) },
  consentPort: CONSENT_PORT,
});

writeFileSync(path.join(work, "Dockerfile"), `FROM ${IMAGE}\n`);
const config = {
  name: "ragbot-builder",
  main: path.join(ROOT, "test/e2e-worker.ts"),
  compatibility_date: "2026-08-22",
  compatibility_flags: ["nodejs_compat"],
  define: {
    E2E_MODEL: JSON.stringify(`http://127.0.0.1:${MODEL_PORT}`),
    E2E_DISCORD: JSON.stringify(`http://127.0.0.1:${DISCORD_PORT}`),
  },
  vars: {
    APP_ORIGIN: ORIGIN,
    ALLOWED_GUILD_IDS: GUILD,
    DISCORD_CLIENT_ID: "e2e-client",
    DISCORD_CLIENT_SECRET: "e2e-secret",
    CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    AI_GATEWAY_ID: "e2e-gateway",
    CF_AIG_TOKEN: "e2e-aig-token",
    CODING_MODEL: "gpt-5.5",
    CODING_REASONING_EFFORT: "medium",
  },
  containers: [
    {
      class_name: "BuildContainer",
      image: path.join(work, "Dockerfile"),
      max_instances: 3,
    },
  ],
  durable_objects: {
    bindings: [
      { name: "RUNNERS", class_name: "BuildContainer" },
      { name: "PROJECTS", class_name: "Project" },
      { name: "AUTH", class_name: "Auth" },
      { name: "ROOMS", class_name: "Rooms" },
      { name: "DIRECTORY", class_name: "Directory" },
    ],
  },
  migrations: [
    {
      tag: "v1",
      new_sqlite_classes: [
        "BuildContainer",
        "Project",
        "Auth",
        "Rooms",
        "Directory",
      ],
    },
  ],
  r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "ragbot-build-artifacts" }],
  worker_loaders: [{ binding: "LOADER" }],
  dev: {
    ip: "127.0.0.1",
    port: 443,
    local_protocol: "https",
    host: "apps.test",
  },
};
writeFileSync(
  path.join(work, "wrangler.json"),
  JSON.stringify(config, null, 2),
);

step("Starting wrangler dev");
let logs = "";
const wrangler = spawn(
  path.join(ROOT, "node_modules/.bin/wrangler"),
  [
    "dev",
    "-c",
    path.join(work, "wrangler.json"),
    "--persist-to",
    path.join(work, "state"),
  ],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
    detached: true,
  },
);
wrangler.stdout.on("data", (chunk) => (logs += chunk));
wrangler.stderr.on("data", (chunk) => (logs += chunk));
let browser;
try {
  for (let i = 0; !logs.includes("Ready on"); i++) {
    assert.ok(
      i < 600 && wrangler.exitCode === null,
      "wrangler dev did not start:\n" + logs.slice(-3000),
    );
    await wait(500);
  }

  // --- helpers ----------------------------------------------------------------

  /** Raw HTTPS to the local Worker, with full control over headers. */
  const raw = (pathname, { method = "GET", headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const request = https.request(
        {
          host: "127.0.0.1",
          port: 443,
          servername: "apps.test",
          path: pathname,
          method,
          headers: { host: "apps.test", ...headers },
          rejectUnauthorized: false,
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              text,
            }),
          );
        },
      );
      request.on("upgrade", (response, socket) => {
        socket.destroy();
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text: "",
        });
      });
      request.on("error", reject);
      request.end(body);
    });
  const control = async (method, input) => {
    const response = await raw(`/__e2e/control/${method}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return JSON.parse(response.text);
  };
  const scope = (user = "alice", extra = {}) => ({
    guild_id: GUILD,
    channel_id: "300000000000000001",
    user_id: USERS[user].id,
    ...extra,
  });
  async function until(id, statuses) {
    for (let i = 0; i < 180; i++) {
      const view = await control("status", { id, ...scope() });
      if (statuses.includes(view.status)) return view;
      assert.ok(
        !["failed", "cancelled"].includes(view.status),
        JSON.stringify(view),
      );
      await wait(5000);
    }
    throw new Error("build timed out");
  }
  const websocket = (pathname, headers) =>
    raw(pathname, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });

  browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM || undefined,
    args: [
      `--host-resolver-rules=MAP apps.test 127.0.0.1, MAP discord.com 127.0.0.1:${CONSENT_PORT}`,
      "--no-proxy-server",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  async function member(name) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 960, height: 720 },
    });
    // Signed in to (fake) Discord as `name`.
    await context.addCookies([
      {
        name: "fake_discord_user",
        value: name,
        domain: "discord.com",
        path: "/",
        secure: true,
      },
    ]);
    return context;
  }
  const sessionCookie = async (context) =>
    (await context.cookies(ORIGIN))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

  // --- build ------------------------------------------------------------------

  step("Submitting a build through BuilderControl");
  const id = "e2e0" + "0123456789abcdef0123456789ab";
  const submitted = await control("submit", {
    id,
    ...scope(),
    prompt: "a three.js cube party we can tap together",
  });
  assert.equal(submitted.status, "queued");
  assert.deepEqual(
    await control("submit", {
      id,
      ...scope(),
      prompt: "a three.js cube party we can tap together",
    }),
    submitted,
  );
  const ready = await until(id, ["ready"]);
  assert.equal(ready.title, "Spinning Cube Party");
  assert.match(ready.summary, /shared tap counter/);
  const appUrl = ready.url;
  const appPath = new URL(appUrl).pathname;
  console.log(`  ready at ${appUrl}`);

  step("Checking what reached AI Gateway");
  const requests = readFileSync(modelLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(requests.length >= 2);
  for (const request of requests) {
    assert.equal(
      request.url,
      "/v1/0123456789abcdef0123456789abcdef/e2e-gateway/openai/responses",
    );
    assert.equal(request.model, "gpt-5.5");
    assert.equal(
      request.headers["cf-aig-authorization"],
      "Bearer e2e-aig-token",
    );
    assert.equal(
      request.headers.authorization,
      undefined,
      "placeholder key must not reach the gateway",
    );
    assert.equal(
      JSON.parse(request.headers["cf-aig-metadata"]).ragbot_kind,
      "build",
    );
  }
  console.log(
    `  ${requests.length} model requests, all keyless with cf-aig-authorization`,
  );

  // --- access control -------------------------------------------------------------

  step("Anonymous and cross-site requests are refused");
  assert.equal((await raw(appPath)).status, 401);
  assert.equal(
    (await raw(appPath, { headers: { accept: "text/html" } })).status,
    401,
  );
  assert.equal((await raw(`${appPath}_api/me`)).status, 401);
  assert.equal(
    (await websocket(`${appPath}_api/rooms/party`, { origin: ORIGIN })).status,
    401,
  );
  assert.equal((await raw("/nope-0000/")).status, 404);

  step("Alice signs in with Discord and opens the app from the hub");
  const aliceContext = await member("alice");
  const alice = await aliceContext.newPage();
  const login = await alice.goto(ORIGIN + "/");
  assert.equal(login.status(), 401);
  await alice.getByRole("link", { name: "Continue with Discord" }).click();
  await alice.waitForURL(ORIGIN + "/");
  await alice.getByRole("link", { name: "Spinning Cube Party" }).waitFor();
  await alice.screenshot({ path: path.join(out, "1-hub.png") });
  await alice.getByRole("link", { name: "Spinning Cube Party" }).click();
  await alice.waitForURL(appUrl);
  await alice.getByText("Signed in as Alice").waitFor();
  await alice.locator("#peers li", { hasText: "Alice" }).waitFor();

  const aliceCookie = await sessionCookie(aliceContext);
  assert.match(aliceCookie, /__Host-ragbot-session=/);
  const cookies = await aliceContext.cookies(ORIGIN);
  assert.ok(
    cookies.every((c) => c.httpOnly && c.secure && c.sameSite === "Lax"),
  );
  const me = JSON.parse(
    (await raw(`${appPath}_api/me`, { headers: { cookie: aliceCookie } })).text,
  );
  assert.deepEqual([me.id, me.name], [USERS.alice.id, "Alice"]);
  assert.equal(
    (
      await websocket(`${appPath}_api/rooms/party`, {
        cookie: aliceCookie,
        origin: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await raw(`${appPath}_api/rooms/party`, {
        method: "PUT",
        headers: { cookie: aliceCookie, origin: "https://evil.test" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await websocket(`${appPath}_api/rooms/party`, {
        cookie: aliceCookie,
        origin: ORIGIN,
      })
    ).status,
    101,
  );
  for (const probe of [
    "..%2f..%2fsecret",
    "%2e%2e%2fx",
    "_api/nope",
    "missing.js",
  ])
    assert.equal(
      (await raw(appPath + probe, { headers: { cookie: aliceCookie } })).status,
      404,
      probe,
    );
  const page = await raw(appPath, { headers: { cookie: aliceCookie } });
  assert.match(page.headers["content-security-policy"], /connect-src 'self'/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");

  step("Bob follows a deep link, signs in, and both see each other live");
  const bobContext = await member("bob");
  const bob = await bobContext.newPage();
  await bob.goto(appUrl);
  await bob.getByRole("link", { name: "Continue with Discord" }).click();
  await bob.waitForURL(appUrl);
  await bob.getByText("Signed in as Bob").waitFor();
  await alice.locator("#peers li", { hasText: "Bob" }).waitFor();
  await bob.locator("#peers li", { hasText: "Alice" }).waitFor();

  step("Shared state is realtime and durable");
  await bob.getByRole("button", { name: "Tap together" }).click();
  await alice.locator("#taps", { hasText: "1" }).waitFor();
  await alice.getByRole("button", { name: "Tap together" }).click();
  await bob.locator("#taps", { hasText: "2" }).waitFor();
  await bob.reload();
  await bob.locator("#taps", { hasText: "2" }).waitFor();
  const painted = await alice.evaluate(() => {
    const canvas = document.getElementById("scene");
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 0) lit++;
    return lit;
  });
  assert.ok(painted > 500, "three.js rendered the cube");
  await alice.screenshot({ path: path.join(out, "2-app-alice.png") });
  await bob.screenshot({ path: path.join(out, "3-app-bob.png") });

  step("Server logic referees a secret and messages players privately");
  await alice.getByLabel("Guess the number").fill("3");
  await alice.getByRole("button", { name: "Guess" }).click();
  await alice.getByText("Try higher").waitFor();
  await bob.waitForTimeout(500);
  assert.equal(
    await bob.locator("#hint").textContent(),
    "",
    "hints are private",
  );
  const snapshot = JSON.parse(
    (
      await raw(`${appPath}_api/rooms/party`, {
        headers: { cookie: aliceCookie },
      })
    ).text,
  );
  assert.deepEqual(
    snapshot.state,
    { taps: 2, winner: null },
    "the answer never leaves the server",
  );
  const overwrite = await raw(`${appPath}_api/rooms/party`, {
    method: "PUT",
    headers: { cookie: aliceCookie, origin: ORIGIN },
    body: JSON.stringify({ state: { taps: 999, winner: "Alice" } }),
  });
  assert.equal(
    overwrite.status,
    409,
    "clients cannot write server-owned state",
  );
  await bob.getByLabel("Guess the number").fill("7");
  await bob.getByRole("button", { name: "Guess" }).click();
  await alice.getByText("Bob found the number!").waitFor();
  await alice.screenshot({ path: path.join(out, "2b-server-logic.png") });

  step("A non-member cannot get in");
  const malloryContext = await member("mallory");
  const mallory = await malloryContext.newPage();
  await mallory.goto(appUrl);
  await mallory.getByRole("link", { name: "Continue with Discord" }).click();
  await mallory.getByText("Could not sign you in").waitFor();
  await mallory.screenshot({ path: path.join(out, "4-non-member.png") });
  assert.equal(
    (await malloryContext.cookies(ORIGIN)).filter(
      (c) => c.name === "__Host-ragbot-session",
    ).length,
    0,
  );
  assert.equal((await mallory.goto(appUrl)).status(), 401);

  step("Only the owner or a moderator can manage the app");
  assert.equal(
    (await control("delete", { id, ...scope("bob") })).error,
    "forbidden",
  );
  assert.equal(
    (
      await control("status", {
        id,
        ...scope("alice", { guild_id: "999999999999999999" }),
      })
    ).error,
    "invalid_scope",
  );

  step("A revision builds from the saved source, then rolls back");
  const edit = {
    id,
    ...scope(),
    prompt: "call it version two",
    operation: "300000000000000099",
  };
  assert.equal((await control("edit", edit)).revision, 2);
  assert.equal(
    (await control("edit", edit)).revision,
    2,
    "the same Discord message cannot start two revisions",
  );
  assert.equal(
    (await control("edit", { ...edit, operation: "300000000000000098" })).error,
    "busy",
  );
  const second = await until(id, ["ready"]);
  assert.deepEqual([second.active, second.releases], [2, [1, 2]]);
  await alice.reload();
  assert.equal(await alice.title(), "Spinning Cube Party v2");
  await alice.locator("#taps", { hasText: "2" }).waitFor();
  await alice.getByLabel("Guess the number").fill("9");
  await alice.getByRole("button", { name: "Guess" }).click();
  await alice.getByText("Try lower").waitFor();
  assert.equal(
    (await control("rollback", { id, ...scope(), revision: 1 })).active,
    1,
  );
  await alice.reload();
  assert.equal(await alice.title(), "Spinning Cube Party");

  step("Deleting removes the app, its data, and the hub entry");
  assert.equal(
    (await control("delete", { id, ...scope("bob", { moderator: true }) }))
      .status,
    "deleted",
  );
  for (
    let i = 0;
    i < 30 &&
    (await raw(appPath, { headers: { cookie: aliceCookie } })).status !== 404;
    i++
  )
    await wait(1000);
  assert.equal(
    (await raw(appPath, { headers: { cookie: aliceCookie } })).status,
    404,
  );
  await alice.goto(ORIGIN + "/");
  await alice.getByText("No apps yet").waitFor();

  console.log(`\n✔ End-to-end test passed. Screenshots: ${out}`);
} catch (error) {
  console.error(logs.slice(-6000));
  throw error;
} finally {
  await browser?.close();
  try {
    process.kill(-wrangler.pid, "SIGINT");
  } catch {}
  model.close();
  discord.close();
  await wait(2000);
}
