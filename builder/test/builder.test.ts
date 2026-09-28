import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeAll, afterEach, describe, it, expect, vi } from "vitest";
import worker, { BuilderControl } from "../src/index";
import { project, type Env, hash } from "../src/types";
import { authCall, cookie } from "../src/auth";
import { validateArtifact } from "../src/project";
import { score } from "../src/rooms";
const e = env as unknown as Env;
const scope = {
  guild_id: "457689460096630794",
  channel_id: "123456789012345681",
  user_id: "123456789012345679",
};
function fresh() {
  return crypto.randomUUID().replaceAll("-", "");
}
async function call(id: string, path: string, data: any = {}) {
  const response = await project(e, id).fetch(
    new Request("https://p/" + path, {
      method: "POST",
      body: JSON.stringify({
        ...scope,
        model: "gpt-6-sol",
        instructions: "Build the app.",
        config_revision: "test",
        ...data,
      }),
    }),
  );
  return new Response(await response.text(), {
    status: response.status,
    headers: response.headers,
  });
}
async function submit(id: string) {
  return call(id, "submit", {
    id,
    source_id: "123456789012345680",
    prompt: "wordle together",
    kind: "site",
  });
}
async function session(id: string, user = scope.user_id) {
  // Exercise the real one-use passcode exchange with Discord membership mocked.

  const issued = await authCall(e, "/invite", {
    ...scope,
    user_id: user,
    project: id,
  });
  expect(issued.status).toBe(200);
  const code = (await issued.json<any>()).code;
  const redeemed = await authCall(e, "/redeem", {
    project: id,
    code,
    ip: user,
  });
  expect(redeemed.status).toBe(200);
  const result = await redeemed.json<any>();
  return { cookie: `__Host-rag-session=${result.session}`, code };
}
beforeAll(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      const match = url.match(
        /^https:\/\/discord.com\/api\/v10\/guilds\/457689460096630794\/members\/(\d+)$/,
      );
      if (match)
        return Response.json({ user: { id: match[1] }, pending: false });
      throw new Error("Unexpected external network request");
    }),
  ),
);
it("builds once, publishes immutable assets and keeps the previous revision live", async () => {
  const id = fresh();
  expect((await submit(id)).status).toBe(200);
  await submit(id);
  const stub = project(e, id);
  await runDurableObjectAlarm(stub);
  await runDurableObjectAlarm(stub);
  const status = await (await call(id, "status")).json<any>();
  expect(status.status).toBe("ready");
  expect(status.releases).toEqual([1]);
  expect(
    (await e.ARTIFACTS.get(`${id}/1/public/index.html`))?.size,
  ).toBeGreaterThan(0);
  const edit = { prompt: "make it blue", source_id: "123456789012345699" };
  await call(id, "edit", edit);
  const duplicate = await call(id, "edit", edit);
  expect(duplicate.status).toBe(200);
  const next = await (await call(id, "status")).json<any>();
  expect(next.revision).toBe(2);
  expect(next.active).toBe(1);
});
it("rejects cross-guild lookup and non-owner cancellation", async () => {
  const id = fresh();
  await submit(id);
  expect(
    (await call(id, "status", { guild_id: "999999999999999999" })).status,
  ).toBe(403);
  expect(
    (await call(id, "cancel", { user_id: "999999999999999999" })).status,
  ).toBe(403);
  await call(id, "cancel");
  await runDurableObjectAlarm(project(e, id));
  expect((await (await call(id, "status")).json<any>()).status).toBe(
    "cancelled",
  );
  expect(await e.ARTIFACTS.get(`${id}/1/public/index.html`)).toBeNull();
});
it("restarts a lost container during testing and completes the same revision", async () => {
  const id = fresh();
  await submit(id);
  const stub = project(e, id);
  await runDurableObjectAlarm(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    const job = await state.storage.get<any>("job");
    job.status = "testing";
    await state.storage.put("job", job);
  });
  await e.RUNNERS.get(e.RUNNERS.idFromName(`${id}-1`)).destroy();
  await runDurableObjectAlarm(stub);
  await runDurableObjectAlarm(stub);
  const status = await (await call(id, "status")).json<any>();
  expect(status.status).toBe("ready");
  expect(status.revision).toBe(1);
  expect(status.releases).toEqual([1]);
});
it("carries earlier feature changes into a revision's published artifact", async () => {
  const id = fresh();
  await submit(id);
  const stub = project(e, id);
  await runDurableObjectAlarm(stub);
  await e.ARTIFACTS.put(
    `${id}/1/artifact.json`,
    JSON.stringify({
      source: {},
      files: {},
      tests: ["test"],
      changes: { "first.py": "earlier change" },
    }),
  );
  await runInDurableObject(stub, async (_instance, state) => {
    const job = await state.storage.get<any>("job");
    job.kind = "feature";
    job.revision = 2;
    job.seed_revision = 1;
    await state.storage.put("job", job);
  });
  const runner = e.RUNNERS.get(e.RUNNERS.idFromName(`${id}-2`));
  await runInDurableObject(runner, async (_instance, state) => {
    await state.storage.put("started", true);
    await state.storage.put("artifact", {
      source: {},
      files: {},
      tests: ["test"],
      changes: { "second.py": "new change" },
    });
  });
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json([
        { html_url: "https://github.com/test/repo/pull/1", number: 1 },
      ]),
    ),
  );
  try {
    await runDurableObjectAlarm(stub);
    const artifact = await (await e.ARTIFACTS.get(
      `${id}/2/artifact.json`,
    ))!.json<any>();
    expect(artifact.changes).toEqual({
      "first.py": "earlier change",
      "second.py": "new change",
    });
    expect((await (await call(id, "status")).json<any>()).status).toBe(
      "pr_ready",
    );
  } finally {
    vi.stubGlobal("fetch", original);
  }
});
it("protects assets, blocks provider hosts and scopes sessions to projects", async () => {
  const id = fresh(),
    other = fresh();
  await submit(id);
  await submit(other);
  await runDurableObjectAlarm(project(e, id));
  await runDurableObjectAlarm(project(e, id));
  const url = `https://${id}.apps.test/`;
  expect((await worker.fetch(new Request(url), e)).status).toBe(401);
  expect(
    (await worker.fetch(new Request("https://ragbot-builder.workers.dev/"), e))
      .status,
  ).toBe(404);
  const s = await session(id);
  const r = await worker.fetch(
    new Request(url, { headers: { cookie: s.cookie } }),
    e,
  );
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("Shared game");
  expect(
    (
      await worker.fetch(
        new Request(`https://${other}.apps.test/`, {
          headers: { cookie: s.cookie },
        }),
        e,
      )
    ).status,
  ).toBe(401);
  expect(
    (await authCall(e, "/redeem", { project: id, code: s.code, ip: "other" }))
      .status,
  ).toBe(403);
});
it("two members share a room with conflict detection and a hidden answer", async () => {
  const id = fresh();
  await submit(id);
  const a = await session(id),
    b = await session(id, "123456789012345682");
  const origin = `https://${id}.apps.test`,
    url = origin + "/_wordle/lobby";
  const first = await (
    await worker.fetch(new Request(url, { headers: { cookie: a.cookie } }), e)
  ).json<any>();
  expect(first.answer).toBeUndefined();
  const move = (cookie: string, guess: string) =>
    worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ version: first.version, guess }),
      }),
      e,
    );
  expect((await move(a.cookie, "apple")).status).toBe(200);
  expect((await move(b.cookie, "crane")).status).toBe(409);
  const updated = await (
    await worker.fetch(new Request(url, { headers: { cookie: b.cookie } }), e)
  ).json<any>();
  expect(updated.guesses).toHaveLength(1);
  const crossOrigin = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { cookie: b.cookie, origin: "https://evil.test" },
      body: "{}",
    }),
    e,
  );
  expect(crossOrigin.status).toBe(403);
});
it("handles repeated letters correctly and rejects artifact traversal", () => {
  expect(score("apple", "allee")).toEqual([
    "correct",
    "present",
    "absent",
    "absent",
    "correct",
  ]);
  expect(() =>
    validateArtifact(
      {
        source: {},
        files: { "../secret": "bad", "index.html": "hello" },
        tests: ["ok"],
      },
      "site",
    ),
  ).toThrow();
});

it("binds OAuth state to the browser and consumes tickets once", async () => {
  const id = fresh();
  await submit(id);
  const wrong = await (
    await authCall(e, "/state", {
      project: id,
      guild: scope.guild_id,
      nonce: "nonce",
      browser: "browser",
    })
  ).json<any>();
  expect(
    (
      await authCall(e, "/exchange", {
        state: wrong.state,
        browser: "attacker",
        code: "x",
      })
    ).status,
  ).toBe(403);
  const state = await (
    await authCall(e, "/state", {
      project: id,
      guild: scope.guild_id,
      nonce: "nonce",
      browser: "browser",
    })
  ).json<any>();
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const u = String(input);
      if (u === "https://discord.com/api/v10/oauth2/token")
        return Response.json({
          access_token: "oauth-test-token",
          expires_in: 3600,
        });
      if (u === "https://discord.com/api/v10/users/@me")
        return Response.json({ id: scope.user_id });
      if (
        u ===
        `https://discord.com/api/v10/users/@me/guilds/${scope.guild_id}/member`
      )
        return Response.json({ user: { id: scope.user_id } });
      throw new Error("Unexpected network");
    }),
  );
  try {
    const exchange = await authCall(e, "/exchange", {
      state: state.state,
      browser: "browser",
      code: "code",
    });
    expect(exchange.status).toBe(200);
    const ticket = (await exchange.json<any>()).ticket;
    expect(
      (await authCall(e, "/complete", { project: id, nonce: "bad", ticket }))
        .status,
    ).toBe(403);
    const completed = await authCall(e, "/complete", {
      project: id,
      nonce: "nonce",
      ticket,
    });
    expect(completed.status).toBe(200);
    expect(
      (await authCall(e, "/complete", { project: id, nonce: "nonce", ticket }))
        .status,
    ).toBe(403);
    const s = (await completed.json<any>()).session;
    expect(
      (await authCall(e, "/session", { project: id, session: s })).status,
    ).toBe(200);
    await authCall(e, "/logout", { session: s });
    expect(
      (await authCall(e, "/session", { project: id, session: s })).status,
    ).toBe(401);
  } finally {
    vi.stubGlobal("fetch", original);
  }
});

it("fails closed when guild membership is revoked", async () => {
  const id = fresh();
  await submit(id);
  const s = await session(id);
  const { runInDurableObject } = await import("cloudflare:test");
  const authStub = e.AUTH.get(e.AUTH.idFromName("auth-v1"));
  await runInDurableObject(authStub, async (_instance, state) => {
    const key = "session:" + (await hash(s.cookie.split("=")[1]));
    const value = await state.storage.get<any>(key);
    value.checked = 0;
    await state.storage.put(key, value);
  });
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  try {
    expect(
      (
        await worker.fetch(
          new Request(`https://${id}.apps.test/`, {
            headers: { cookie: s.cookie },
          }),
          e,
        )
      ).status,
    ).toBe(401);
  } finally {
    vi.stubGlobal("fetch", original);
  }
});

it("resumes from persisted state in a new instance and rolls back a release", async () => {
  const { runInDurableObject } = await import("cloudflare:test");
  const { Project } = await import("../src/project");
  const id = fresh();
  await submit(id);
  await runDurableObjectAlarm(project(e, id));
  await runInDurableObject(project(e, id), async (_instance, state) => {
    await new Project(state, e).alarm();
  });
  expect((await (await call(id, "status")).json<any>()).status).toBe("ready");
  await call(id, "edit", {
    prompt: "second version",
    source_id: "123456789012345701",
  });
  await runDurableObjectAlarm(project(e, id));
  await runDurableObjectAlarm(project(e, id));
  expect((await (await call(id, "status")).json<any>()).active).toBe(2);
  await call(id, "rollback", { revision: 1 });
  expect((await (await call(id, "status")).json<any>()).active).toBe(1);
});

it("injects model credentials only at the fixed provider host", async () => {
  const { buildEgress } = await import("../src/egress");
  expect((await buildEgress(new Request("https://evil.test"), e)).status).toBe(
    403,
  );
  expect(
    (
      await buildEgress(
        new Request("http://model.internal/v1/files", { method: "POST" }),
        e,
      )
    ).status,
  ).toBe(403);
  const original = globalThis.fetch;
  let called = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo, options?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer test-provider-key",
      );
      expect(options?.redirect).toBe("error");
      called = true;
      return Response.json({ ok: true });
    }),
  );
  try {
    const r = await buildEgress(
      new Request("http://model.internal/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "test-model", input: "hello" }),
      }),
      { ...e, OPENAI_API_KEY: "test-provider-key", CODEX_MODEL: "test-model" },
    );
    expect(r.ok && called).toBe(true);
  } finally {
    vi.stubGlobal("fetch", original);
  }
});

it("reconciles an already-created PR without creating another", async () => {
  const { publishPR, validateChanges } = await import("../src/github");
  expect(() =>
    validateChanges({ ".github/workflows/pwn.yml": "bad" }),
  ).toThrow();
  const original = globalThis.fetch;
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo, options?: RequestInit) => {
      expect(String(url)).toMatch(
        /^https:\/\/api.github.com\/repos\/owner\/repo\/pulls\?/,
      );
      expect(options?.method).toBe("GET");
      calls++;
      return Response.json([
        { number: 12, html_url: "https://github.com/owner/repo/pull/12" },
      ]);
    }),
  );
  try {
    const result = await publishPR(
      { ...e, GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "test-token" },
      { id: fresh(), revision: 1 } as any,
      {
        source: {},
        files: {},
        changes: { "src/new.py": "pass" },
        tests: ["pnpm test"],
      },
    );
    expect(result.number).toBe(12);
    expect(calls).toBe(1);
  } finally {
    vi.stubGlobal("fetch", original);
  }
});

it("deletes published assets and shared room data and revokes app access", async () => {
  const id = fresh();
  await submit(id);
  await runDurableObjectAlarm(project(e, id));
  await runDurableObjectAlarm(project(e, id));
  const s = await session(id),
    origin = `https://${id}.apps.test`;
  await worker.fetch(
    new Request(origin + "/_room/lobby", {
      method: "PUT",
      headers: { cookie: s.cookie, origin },
      body: JSON.stringify({ version: 0, data: { secret: "member data" } }),
    }),
    e,
  );
  const source = await worker.fetch(
    new Request(origin + "/_source", { headers: { cookie: s.cookie } }),
    e,
  );
  expect(source.status).toBe(200);
  expect((await call(id, "delete")).status).toBe(200);
  expect((await (await call(id, "cancel")).json<any>()).status).toBe("deleted");
  await runDurableObjectAlarm(project(e, id));
  expect((await e.ARTIFACTS.list({ prefix: id + "/" })).objects).toHaveLength(
    0,
  );
  expect(
    (
      await worker.fetch(
        new Request(origin + "/", { headers: { cookie: s.cookie } }),
        e,
      )
    ).status,
  ).toBe(404);
  const room = e.ROOMS.get(e.ROOMS.idFromName(id + ":room:lobby"));
  expect(
    (await (await room.fetch("https://room/state")).json<any>()).data,
  ).toEqual({});
});

it("creates a draft PR using an immutable base and a deterministic branch", async () => {
  const { publishPR } = await import("../src/github");
  const original = globalThis.fetch,
    id = fresh();
  let created = false;
  const writes: { path: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, options?: RequestInit) => {
      const u = new URL(String(input));
      expect(u.origin).toBe("https://api.github.com");
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer test-token",
      );
      const method = options?.method || "GET",
        path = u.pathname.replace("/repos/owner/repo/", "");
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      if (method === "POST") writes.push({ path, body });
      if (path === "pulls" && method === "GET")
        return Response.json(
          created
            ? [{ number: 1, html_url: "https://github.com/owner/repo/pull/1" }]
            : [],
        );
      if (path === "git/commits/base")
        return Response.json({ tree: { sha: "oldtree" } });
      if (path === "git/trees") return Response.json({ sha: "newtree" });
      if (path === "git/commits") return Response.json({ sha: "newcommit" });
      if (path.startsWith("git/ref/heads/"))
        return new Response(null, { status: 404 });
      if (path === "git/refs") return Response.json({ ref: body.ref });
      if (path === "pulls" && method === "POST") {
        created = true;
        return Response.json({ number: 1 });
      }
      throw new Error("Unexpected GitHub request");
    }),
  );
  try {
    const result = await publishPR(
      {
        ...e,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_TOKEN: "test-token",
        GITHUB_BASE_BRANCH: "main",
      },
      {
        id,
        revision: 2,
        base_sha: "base",
        prompt: "Add a useful command",
      } as any,
      {
        source: {},
        files: {},
        changes: { "src/new.py": "pass" },
        tests: ["pnpm run check", "pnpm test", "pnpm run test:runtime"],
      },
    );
    expect(result.number).toBe(1);
    expect(writes.find((w) => w.path === "git/commits")?.body.parents).toEqual([
      "base",
    ]);
    expect(writes.find((w) => w.path === "git/refs")?.body.ref).toBe(
      `refs/heads/ragbot-build/${id}-2`,
    );
    expect(writes.find((w) => w.path === "pulls")?.body.draft).toBe(true);
  } finally {
    vi.stubGlobal("fetch", original);
  }
});
