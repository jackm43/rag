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
    const setup = {
      ...defaults,
      ...(await this.ctx.storage.get<Setup>("setup")),
    };
    await this.ctx.storage.put("calls", [
      ...(await this.calls()),
      `${request.method} ${url.pathname}`,
    ]);
    if (url.pathname === "/source" && request.method === "PUT") {
      await this.ctx.storage.put("seed", await request.text());
      return Response.json({});
    }
    if (url.pathname === "/start") {
      const job = await request.json();
      await this.ctx.storage.put({ job, started: job });
      return Response.json({}, { status: 202 });
    }
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
    if (url.pathname === "/source")
      return new Response(`source-of-${JSON.stringify(job)}`);
    return new Response(null, { status: 404 });
  }
  async destroy() {
    await this.ctx.storage.delete(["job"]);
  }
}
