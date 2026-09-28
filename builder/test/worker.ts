export { default, BuilderControl, Project, Auth, Room } from "../src/index";
import { DurableObject } from "cloudflare:workers";
export class FakeRunner extends DurableObject {
  async fetch(r: Request) {
    if (new URL(r.url).pathname === "/cancel") {
      await this.ctx.storage.put("cancelled", true);
      return Response.json({});
    }
    if (new URL(r.url).pathname === "/start") {
      await this.ctx.storage.put("started", true);
      return Response.json({});
    }
    if (!(await this.ctx.storage.get("started")))
      return Response.json({ status: "idle" });
    return Response.json({
      status: "complete",
      artifact: (await this.ctx.storage.get("artifact")) ?? {
        files: { "index.html": "<h1>Shared game</h1>" },
        source: { "public/index.html": "<h1>Shared game</h1>" },
        tests: ["node --test"],
      },
    });
  }
  async destroy() {
    await this.ctx.storage.deleteAll();
  }
}
