import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { directory, slugFor } from "../src/directory";
import { egress } from "../src/egress";
import worker, { BuilderControl } from "../src/index";
import { validManifest } from "../src/project";
import { type Env, hash, project } from "../src/types";

const e = env as unknown as Env;
const GUILD = "457689460096630794";
const ALICE = "200000000000000001";
const BOB = "200000000000000002";
const MALLORY = "200000000000000003";
const ORIGIN = "https://apps.test";
const scope = (user = ALICE, extra = {}) => ({
  guild_id: GUILD,
  channel_id: "300000000000000001",
  user_id: user,
  ...extra,
});
const fresh = () => crypto.randomUUID().replaceAll("-", "");
const control = () =>
  new BuilderControl({ waitUntil() {}, passThroughOnException() {} } as any, e);
const runner = (id: string, revision = 1) =>
  e.RUNNERS.get(e.RUNNERS.idFromName(`${id}:${revision}`)) as any;

// Discord as seen by the Worker: alice and bob are members, mallory is not.
const members = new Set([ALICE, BOB]);
function discord(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  expect(url.origin).toBe("https://discord.com");
  expect(request.redirect).toBe("manual");
  const user =
    request.headers.get("authorization")?.replace("Bearer token-", "") ?? "";
  if (url.pathname === "/api/v10/oauth2/token")
    return request.text().then((body) => {
      const form = new URLSearchParams(body);
      expect(form.get("redirect_uri")).toBe(`${ORIGIN}/_auth/callback`);
      expect(form.get("client_secret")).toBe("test-secret");
      return Response.json({
        access_token: `token-${form.get("code")}`,
        expires_in: 604800,
        scope: "identify guilds.members.read",
      });
    });
  if (url.pathname === `/api/v10/users/@me/guilds/${GUILD}/member`)
    return members.has(user)
      ? Response.json({
          user: {
            id: user,
            username: `user${user.slice(-1)}`,
            global_name: null,
            avatar: null,
          },
          nick: user === ALICE ? "Alice" : null,
          pending: false,
        })
      : new Response(null, { status: 404 });
  throw new Error(`unexpected request ${url}`);
}

beforeEach(() => {
  members.clear();
  members.add(ALICE).add(BOB);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      discord(input, init),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** Log in through the real routes; returns the session cookie. */
async function login(user: string) {
  const start = await worker.fetch(
    new Request(`${ORIGIN}/_auth/login?back=/`),
    e,
  );
  expect(start.status).toBe(303);
  const authorize = new URL(start.headers.get("location")!);
  expect(authorize.origin + authorize.pathname).toBe(
    "https://discord.com/oauth2/authorize",
  );
  expect(authorize.searchParams.get("scope")).toBe(
    "identify guilds.members.read",
  );
  const browser = start.headers.get("set-cookie")!.split(";")[0];
  const callback = await worker.fetch(
    new Request(
      `${ORIGIN}/_auth/callback?code=${user}&state=${authorize.searchParams.get("state")}`,
      { headers: { cookie: browser } },
    ),
    e,
  );
  const session = callback.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-ragbot-session="));
  return {
    status: callback.status,
    cookie: session?.split(";")[0] ?? "",
    setCookie: session ?? "",
  };
}

/** Run the project's alarms (miniflare also fires them itself) until `done`. */
async function drive(id: string, done: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await done()) return;
    await runDurableObjectAlarm(project(e, id));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("project did not settle");
}

const settled = (id: string, statuses = ["ready", "failed", "cancelled"]) =>
  drive(id, async () =>
    statuses.includes((await control().status({ id, ...scope() })).status),
  );

async function build(id = fresh(), prompt = "a shared drawing game") {
  await control().submit({ id, ...scope(), prompt });
  await settled(id);
  return control().status({ id, ...scope() });
}

describe("build lifecycle", () => {
  it("builds once, publishes to R2 and lists the app", async () => {
    const id = fresh();
    const first = await control().submit({
      id,
      ...scope(),
      prompt: "Build me a shared drawing game!",
    });
    expect(first).toMatchObject({
      status: "queued",
      slug: `shared-drawing-${id.slice(0, 4)}`,
    });
    expect(
      await control().submit({ id, ...scope(), prompt: "different" }),
    ).toEqual(first);
    await expect(
      control().submit({ id, ...scope(BOB), prompt: "hijack" }),
    ).rejects.toThrow("conflict");
    const view = await build(id);
    expect(view).toMatchObject({
      status: "ready",
      active: 1,
      releases: [1],
      title: "Test app",
      summary: "A test app.",
    });
    expect(view.url).toBe(`${ORIGIN}/${first.slug}/`);
    expect(
      await (await e.ARTIFACTS.get(`${id}/1/site/index.html`))!.text(),
    ).toContain("Shared game");
    expect(await e.ARTIFACTS.head(`${id}/1/source.tar.gz`)).not.toBeNull();
    expect((await directory(e).list([GUILD])).map((app) => app.id)).toContain(
      id,
    );
    expect(await runner(id).calls()).toEqual(
      expect.arrayContaining([
        "POST /start",
        "GET /status",
        "GET /file/index.html",
        "GET /source",
      ]),
    );
  });

  it("rejects scopes outside the configured guild and bad prompts", async () => {
    const id = fresh();
    await expect(
      control().submit({
        id,
        ...scope(ALICE, { guild_id: "999999999999999999" }),
        prompt: "x",
      }),
    ).rejects.toThrow("invalid_scope");
    await expect(
      control().submit({ id, ...scope(), prompt: " " }),
    ).rejects.toThrow("invalid_prompt");
    await expect(
      control().submit({ id: "../../x", ...scope(), prompt: "x" }),
    ).rejects.toThrow("invalid_scope");
  });

  it("builds revisions from the active release's source and rolls back", async () => {
    const id = fresh();
    await build(id);
    const edit = {
      id,
      ...scope(),
      prompt: "make it blue",
      operation: "300000000000000010",
    };
    expect((await control().edit(edit)).revision).toBe(2);
    expect((await control().edit(edit)).revision).toBe(2);
    await expect(
      control().edit({ ...edit, operation: "300000000000000011" }),
    ).rejects.toThrow("busy");
    await settled(id);
    expect(await control().status({ id, ...scope() })).toMatchObject({
      active: 2,
      releases: [1, 2],
    });
    await runInDurableObject(runner(id, 2), async (_instance, state) => {
      expect(await state.storage.get("seed")).toContain(`"id":"${id}:1"`);
      expect(await state.storage.get<any>("started")).toMatchObject({
        seeded: true,
        request: "a shared drawing game",
        change: "make it blue",
      });
    });
    expect(
      (await control().rollback({ id, ...scope(), revision: 1 })).active,
    ).toBe(1);
    await expect(
      control().rollback({ id, ...scope(), revision: 7 }),
    ).rejects.toThrow("unknown_release");
  });

  it("keeps the last release live when a revision fails", async () => {
    const id = fresh();
    await build(id);
    await runner(id, 2).configure({ phase: "failed", error: "tests_failed" });
    await control().edit({
      id,
      ...scope(),
      prompt: "break it",
      operation: "300000000000000012",
    });
    await settled(id, ["failed"]);
    expect(await control().status({ id, ...scope() })).toMatchObject({
      status: "failed",
      error: "tests_failed",
      active: 1,
    });
  });

  it("rebuilds from scratch when a change follows a failed first build", async () => {
    const id = fresh();
    await runner(id).configure({ phase: "failed", error: "build_failed" });
    await build(id, "a snake game");
    await control().edit({
      id,
      ...scope(),
      prompt: "with neon colours",
      operation: "300000000000000013",
    });
    await settled(id);
    await runInDurableObject(runner(id, 2), async (_instance, state) => {
      expect(await state.storage.get<any>("started")).toMatchObject({
        seeded: false,
        request: "a snake game\n\nwith neon colours",
      });
      expect((await state.storage.get<any>("started")).change).toBeUndefined();
    });
  });

  it("restarts a lost container a bounded number of times", async () => {
    const id = fresh();
    await runner(id).configure({ phase: "building" });
    await control().submit({ id, ...scope(), prompt: "game" });
    let starts = 0;
    await drive(id, async () => {
      // Each time the build is running, the container "restarts" and loses it.
      if (
        (await runner(id).calls()).filter((c: string) => c === "POST /start")
          .length > starts
      ) {
        starts++;
        await runner(id).destroy();
      }
      return (await control().status({ id, ...scope() })).status === "failed";
    });
    expect(await control().status({ id, ...scope() })).toMatchObject({
      status: "failed",
      error: "runner_lost",
    });
    expect(starts).toBe(3);
  });

  it("refuses unsafe build output", async () => {
    for (const files of [
      [
        { path: "_api/rooms/x", body: "x" },
        { path: "index.html", body: "x" },
      ],
      [
        { path: "../escape.html", body: "x" },
        { path: "index.html", body: "x" },
      ],
      [{ path: "app.js", body: "x" }],
    ]) {
      const id = fresh();
      await runner(id).configure({ files });
      await build(id);
      await settled(id);
      expect(await control().status({ id, ...scope() })).toMatchObject({
        status: "failed",
        error: "invalid_output",
      });
    }
    expect(
      validManifest([{ path: "index.html", size: 26 * 1024 * 1024 }]),
    ).toBe(false);
    expect(
      validManifest([
        { path: ".env", size: 1 },
        { path: "index.html", size: 1 },
      ]),
    ).toBe(false);
  });

  it("lets only the owner or a moderator manage an app, and cleans up on delete", async () => {
    const id = fresh();
    const view = await build(id);
    await expect(control().cancel({ id, ...scope(BOB) })).rejects.toThrow(
      "forbidden",
    );
    await expect(control().delete({ id, ...scope(BOB) })).rejects.toThrow(
      "forbidden",
    );
    await e.ROOMS.get(e.ROOMS.idFromName(id)).fetch(
      new Request("https://rooms/lobby", {
        method: "PUT",
        headers: {
          "x-member": JSON.stringify({ id: ALICE, name: "A", avatar: null }),
        },
        body: JSON.stringify({ state: { secret: 1 } }),
      }),
    );
    expect(
      (await control().delete({ id, ...scope(BOB, { moderator: true }) }))
        .status,
    ).toBe("deleted");
    await drive(
      id,
      async () =>
        (await e.ARTIFACTS.list({ prefix: `${id}/` })).objects.length === 0,
    );
    expect(
      (await directory(e).list([GUILD])).map((app) => app.id),
    ).not.toContain(id);
    const { cookie } = await login(ALICE);
    expect(
      (
        await worker.fetch(
          new Request(`${ORIGIN}/${view.slug}/`, { headers: { cookie } }),
          e,
        )
      ).status,
    ).toBe(404);
  });

  it("cancels an active build", async () => {
    const id = fresh();
    await runner(id).configure({ phase: "building" });
    await control().submit({ id, ...scope(), prompt: "game" });
    await settled(id, ["building"]);
    expect((await control().cancel({ id, ...scope() })).status).toBe(
      "cancelled",
    );
    await runDurableObjectAlarm(project(e, id));
    expect(await control().status({ id, ...scope() })).toMatchObject({
      status: "cancelled",
      releases: [],
    });
    expect(await e.ARTIFACTS.head(`${id}/1/site/index.html`)).toBeNull();
  });
});

describe("Discord login and access", () => {
  it("admits guild members only, with hardened cookies", async () => {
    const alice = await login(ALICE);
    expect(alice.status).toBe(303);
    expect(alice.setCookie).toMatch(/Secure; HttpOnly; SameSite=Lax/);
    const mallory = await login(MALLORY);
    expect([mallory.status, mallory.cookie]).toEqual([403, ""]);
  });

  it("binds OAuth state to the browser and uses it once", async () => {
    const start = await worker.fetch(new Request(`${ORIGIN}/_auth/login`), e);
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    );
    const browser = start.headers.get("set-cookie")!.split(";")[0];
    const other = await worker.fetch(
      new Request(`${ORIGIN}/_auth/callback?code=${ALICE}&state=${state}`, {
        headers: { cookie: "__Host-ragbot-login=attacker" },
      }),
      e,
    );
    expect(other.status).toBe(403);
    const replay = await worker.fetch(
      new Request(`${ORIGIN}/_auth/callback?code=${ALICE}&state=${state}`, {
        headers: { cookie: browser },
      }),
      e,
    );
    expect(replay.status).toBe(403);
  });

  it("guards every app route and re-checks membership", async () => {
    const view = await build();
    const app = `${ORIGIN}/${view.slug}/`;
    expect((await worker.fetch(new Request(app), e)).status).toBe(401);
    expect(
      await (
        await worker.fetch(
          new Request(app, { headers: { accept: "text/html" } }),
          e,
        )
      ).text(),
    ).toContain("Continue with Discord");
    expect(
      (await worker.fetch(new Request(`${ORIGIN}/${view.slug}`), e)).status,
    ).toBe(308);
    const { cookie } = await login(ALICE);
    const page = await worker.fetch(
      new Request(app, { headers: { cookie } }),
      e,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(page.headers.get("cache-control")).toBe("private, no-cache");
    const asset = await worker.fetch(
      new Request(app + "assets/app-1234.js", { headers: { cookie } }),
      e,
    );
    expect([
      asset.headers.get("content-type"),
      asset.headers.get("cache-control"),
    ]).toEqual([
      "text/javascript; charset=utf-8",
      "private, max-age=31536000, immutable",
    ]);
    const etag = page.headers.get("etag")!;
    expect(
      (
        await worker.fetch(
          new Request(app, { headers: { cookie, "if-none-match": etag } }),
          e,
        )
      ).status,
    ).toBe(304);
    expect(
      await (
        await worker.fetch(
          new Request(app + "_api/me", { headers: { cookie } }),
          e,
        )
      ).json(),
    ).toMatchObject({ id: ALICE, name: "Alice" });
    // Membership is re-verified once the five-minute window passes.
    members.delete(ALICE);
    expect(
      (await worker.fetch(new Request(app, { headers: { cookie } }), e)).status,
    ).toBe(200);
    await runInDurableObject(
      e.AUTH.get(e.AUTH.idFromName("sessions")),
      async (_instance, state) => {
        const key = "session:" + (await hash(cookie.split("=")[1]));
        const entry = await state.storage.get<any>(key);
        entry.value.guilds[GUILD].checked = 0;
        await state.storage.put(key, entry);
      },
    );
    expect(
      (await worker.fetch(new Request(app, { headers: { cookie } }), e)).status,
    ).toBe(401);
  });

  it("refuses cross-site mutations, unknown hosts and logout without origin", async () => {
    const view = await build();
    const { cookie } = await login(ALICE);
    const room = `${ORIGIN}/${view.slug}/_api/rooms/lobby`;
    const put = (origin: string) =>
      worker.fetch(
        new Request(room, {
          method: "PUT",
          headers: { cookie, origin },
          body: JSON.stringify({ state: 1 }),
        }),
        e,
      );
    expect((await put("https://evil.test")).status).toBe(403);
    expect((await put(ORIGIN)).status).toBe(200);
    expect(
      (
        await worker.fetch(
          new Request(room, {
            headers: {
              cookie,
              upgrade: "websocket",
              origin: "https://evil.test",
            },
          }),
          e,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          new Request(`https://ragbot-builder.workers.dev/${view.slug}/`, {
            headers: { cookie },
          }),
          e,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          new Request(`http://apps.test/${view.slug}/`, {
            headers: { cookie },
          }),
          e,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          new Request(`${ORIGIN}/_auth/logout`, {
            method: "POST",
            headers: { cookie },
          }),
          e,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          new Request(`${ORIGIN}/_auth/logout`, {
            method: "POST",
            headers: { cookie, origin: ORIGIN },
          }),
          e,
        )
      ).status,
    ).toBe(303);
    expect(
      (
        await worker.fetch(
          new Request(`${ORIGIN}/${view.slug}/`, { headers: { cookie } }),
          e,
        )
      ).status,
    ).toBe(401);
  });

  it("shows members the hub of their guild's apps", async () => {
    const view = await build(fresh(), "neon snake arcade");
    expect((await worker.fetch(new Request(`${ORIGIN}/`), e)).status).toBe(401);
    const { cookie } = await login(BOB);
    const hub = await (
      await worker.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } }), e)
    ).text();
    expect(hub).toContain(`href="/${view.slug}/"`);
    expect(hub).toContain("Sign out user2");
  });
});

describe("rooms", () => {
  async function socket(slug: string, cookie: string) {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/${slug}/_api/rooms/lobby`, {
        headers: { cookie, origin: ORIGIN, upgrade: "websocket" },
      }),
      e,
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const inbox: any[] = [];
    ws.addEventListener("message", (event) =>
      inbox.push(JSON.parse(event.data as string)),
    );
    ws.accept();
    const next = async (type: string) => {
      for (let i = 0; i < 100; i++) {
        const index = inbox.findIndex((m) => m.t === type);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${type} message`);
    };
    return {
      ws,
      next,
      send: (value: unknown) => ws.send(JSON.stringify(value)),
    };
  }

  it("relays messages, tracks presence and versions shared state", async () => {
    const view = await build();
    const [alice, bob] = [await login(ALICE), await login(BOB)];
    const a = await socket(view.slug, alice.cookie);
    const welcome = await a.next("welcome");
    expect(welcome).toMatchObject({
      you: { id: ALICE, name: "Alice" },
      version: 0,
      state: null,
    });
    const b = await socket(view.slug, bob.cookie);
    expect(
      (await b.next("welcome")).peers.map((p: any) => p.id).sort(),
    ).toEqual([ALICE, BOB]);
    expect((await a.next("join")).peer.id).toBe(BOB);

    b.send({ t: "send", data: { move: "e4" } });
    expect(await a.next("message")).toMatchObject({
      from: { id: BOB },
      data: { move: "e4" },
    });

    a.send({ t: "set", version: 0, state: { board: 1 }, ref: "r1" });
    expect(await a.next("state")).toMatchObject({
      version: 1,
      state: { board: 1 },
      ref: "r1",
      by: { id: ALICE },
    });
    expect(await b.next("state")).toMatchObject({
      version: 1,
      state: { board: 1 },
    });
    b.send({ t: "set", version: 0, state: { board: 2 }, ref: "r2" });
    expect(await b.next("state")).toMatchObject({
      conflict: true,
      version: 1,
      state: { board: 1 },
      ref: "r2",
    });

    const http = await worker.fetch(
      new Request(`${ORIGIN}/${view.slug}/_api/rooms/lobby`, {
        headers: { cookie: alice.cookie },
      }),
      e,
    );
    expect(await http.json()).toMatchObject({
      version: 1,
      state: { board: 1 },
    });
    const stale = await worker.fetch(
      new Request(`${ORIGIN}/${view.slug}/_api/rooms/lobby`, {
        method: "PUT",
        headers: { cookie: alice.cookie, origin: ORIGIN },
        body: JSON.stringify({ version: 0, state: {} }),
      }),
      e,
    );
    expect(stale.status).toBe(409);
    const huge = await worker.fetch(
      new Request(`${ORIGIN}/${view.slug}/_api/rooms/lobby`, {
        method: "PUT",
        headers: { cookie: alice.cookie, origin: ORIGIN },
        body: JSON.stringify({ state: "x".repeat(140 * 1024) }),
      }),
      e,
    );
    expect(huge.status).toBe(400);
    b.ws.close();
    expect((await a.next("leave")).peer.id).toBe(BOB);
    a.ws.close();
  });

  it("keeps apps' rooms apart", async () => {
    const [one, two] = [await build(), await build()];
    const { cookie } = await login(ALICE);
    const put = (slug: string, state: unknown) =>
      worker.fetch(
        new Request(`${ORIGIN}/${slug}/_api/rooms/lobby`, {
          method: "PUT",
          headers: { cookie, origin: ORIGIN },
          body: JSON.stringify({ state }),
        }),
        e,
      );
    await put(one.slug, "one");
    await put(two.slug, "two");
    const get = async (slug: string) =>
      (
        await (
          await worker.fetch(
            new Request(`${ORIGIN}/${slug}/_api/rooms/lobby`, {
              headers: { cookie },
            }),
            e,
          )
        ).json<any>()
      ).state;
    expect([await get(one.slug), await get(two.slug)]).toEqual(["one", "two"]);
  });
});

describe("build container egress", () => {
  const ctx = { containerId: "c".repeat(64), className: "BuildContainer" };
  const gateway = `https://gateway.ai.cloudflare.com/v1/${e.CF_ACCOUNT_ID}/${e.AI_GATEWAY_ID}/openai`;

  it("swaps the placeholder key for the gateway token and pins the model", async () => {
    let seen: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = new Request(input, init);
        return new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const response = await egress(
      new Request(`${gateway}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer replaced-by-host",
          "x-api-key": "k",
          cookie: "c",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "some-expensive-model",
          input: "hi",
          stream: true,
        }),
      }),
      e,
      ctx,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(seen!.url).toBe(`${gateway}/responses`);
    expect(seen!.headers.get("cf-aig-authorization")).toBe(
      "Bearer test-aig-token",
    );
    expect([
      seen!.headers.get("authorization"),
      seen!.headers.get("x-api-key"),
      seen!.headers.get("cookie"),
    ]).toEqual([null, null, null]);
    expect(JSON.parse(seen!.headers.get("cf-aig-metadata")!).ragbot_kind).toBe(
      "build",
    );
    expect((await seen!.json<any>()).model).toBe("gpt-5.5");
  });

  it("allows only the model endpoints and npm reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
    const status = async (url: string, method = "GET") =>
      (
        await egress(
          new Request(url, {
            method,
            body: method === "POST" ? "{}" : undefined,
          }),
          e,
          ctx,
        )
      ).status;
    expect(await status(`${gateway}/files`, "POST")).toBe(403);
    expect(await status(`${gateway}/responses`, "GET")).toBe(403);
    expect(
      await status(
        `https://gateway.ai.cloudflare.com/v1/other/gateway/openai/responses`,
        "POST",
      ),
    ).toBe(403);
    expect(await status("https://api.openai.com/v1/responses", "POST")).toBe(
      403,
    );
    expect(await status("https://example.com/")).toBe(403);
    expect(await status("https://registry.npmjs.org/three", "PUT")).toBe(403);
    expect(await status("http://registry.npmjs.org/three")).toBe(403);
    expect(await status("https://registry.npmjs.org/three")).toBe(200);
  });
});

it("derives readable, stable slugs", () => {
  const id = "abcdef0123456789abcdef0123456789";
  expect(slugFor("Build us a Wordle clone we can play together", id)).toBe(
    "wordle-clone-play-abcd",
  );
  expect(slugFor("make a cool three.js demo", id)).toBe("cool-three-js-abcd");
  expect(slugFor("!!!", id)).toBe("app-abcd");
  expect(slugFor("x", id, 8)).toBe("x-abcdef01");
});
