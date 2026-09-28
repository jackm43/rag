export {
  default,
  Auth,
  BuilderControl,
  Directory,
  Project,
  Rooms,
} from "../src/index";
import { DurableObject } from "cloudflare:workers";

// Stands in for BuildContainer (vitest cannot run containers). Speaks the
// runner protocol; tests steer it through `configure`.
type Setup = {
  server?: string;
  files?: { path: string; body: string }[];
  phase?: string;
  error?: string;
};
const defaults: Required<Pick<Setup, "files">> = {
  files: [
    {
      path: "index.html",
      body: "<!doctype html><title>Test app</title><h1>Shared game</h1>",
    },
    { path: "assets/app-1234.js", body: "console.log('hi')" },
  ],
};

export class FakeRunner extends DurableObject {
  async configure(setup: Setup) {
    await this.ctx.storage.put("setup", setup);
  }
  async calls() {
    return (await this.ctx.storage.get<string[]>("calls")) ?? [];
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    // Read the body before touching storage, then record the call and its
    // effect in one write, so a concurrent destroy() sees both or neither.
    const body = request.method === "GET" ? "" : await request.text();
    const setup = {
      ...defaults,
      ...(await this.ctx.storage.get<Setup>("setup")),
    };
    const calls = [
      ...(await this.calls()),
      `${request.method} ${url.pathname}`,
    ];
    if (url.pathname === "/source" && request.method === "PUT") {
      await this.ctx.storage.put({ calls, seed: body });
      return Response.json({});
    }
    if (url.pathname === "/start") {
      const job = JSON.parse(body);
      await this.ctx.storage.put({ calls, job, started: job });
      return Response.json({}, { status: 202 });
    }
    await this.ctx.storage.put("calls", calls);
    const job = await this.ctx.storage.get<{ seeded: boolean }>("job");
    if (url.pathname === "/status") {
      if (!job) return Response.json({ phase: "idle" });
      if (setup.phase)
        return Response.json({ phase: setup.phase, error: setup.error });
      return Response.json({
        phase: "done",
        title: "Test app",
        summary: "A test app.",
        files: setup.files.map((file) => ({
          path: file.path,
          size: new TextEncoder().encode(file.body).byteLength,
        })),
        server: setup.server
          ? new TextEncoder().encode(setup.server).byteLength
          : 0,
      });
    }
    if (url.pathname.startsWith("/file/")) {
      const file = setup.files.find(
        (f) => f.path === decodeURIComponent(url.pathname.slice(6)),
      );
      return file
        ? new Response(file.body)
        : new Response(null, { status: 404 });
    }
    if (url.pathname === "/server" && setup.server)
      return new Response(setup.server);
    if (url.pathname === "/source")
      return new Response(`source-of-${JSON.stringify(job)}`);
    return new Response(null, { status: 404 });
  }
  async destroy() {
    await this.ctx.storage.delete(["job"]);
  }
}
