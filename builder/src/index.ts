import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type Env,
  type Scope,
  type Submission,
  idPattern,
  validScope,
  project,
  json,
  boundedJSON,
} from "./types";
import { authRoute, authenticate, loginPage, authCall } from "./auth";
export { ContainerProxy } from "@cloudflare/containers";
export { Project, BuildContainer } from "./project";
export { Auth } from "./auth";
export { Room } from "./rooms";

// RPC-only entrypoint: the public fetch handler never exposes these methods.
export class BuilderControl extends WorkerEntrypoint<Env> {
  async submit(input: Submission) {
    return this.call(input.id, "submit", input);
  }
  async status(input: Scope & { id: string }) {
    return this.call(input.id, "status", input);
  }
  async action(
    input: Scope & {
      id: string;
      action: string;
      prompt?: string;
      source_id?: string;
      revision?: number;
    },
  ) {
    if (!["cancel", "edit", "rollback", "delete"].includes(input.action))
      throw new Error("invalid_action");
    return this.call(input.id, input.action, input);
  }
  async passcode(input: Scope & { id: string }) {
    // Caller already comes from a signed interaction; validate the channel again.
    await this.call(input.id, "status", input);
    const r = await authCall(this.env, "/invite", {
      ...input,
      project: input.id,
    });
    if (!r.ok) throw new Error("invite_denied");
    return r.json();
  }
  async call(id: string, path: string, input: unknown) {
    const r = await project(this.env, id).fetch(
      new Request("https://project/" + path, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    if (!r.ok) throw new Error("builder_request_failed");
    return r.json();
  }
}
const mime: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "https:") return new Response(null, { status: 403 });
      const suffix = "." + env.APP_DOMAIN;
      const id = url.hostname.endsWith(suffix)
        ? url.hostname.slice(0, -suffix.length)
        : "";
      const projectId = idPattern.test(id) ? id : undefined;
      if (!projectId && url.origin !== env.AUTH_ORIGIN)
        return new Response(null, { status: 404 });
      const route = await authRoute(request, env, projectId);
      if (route) return route;
      if (!projectId) return new Response(null, { status: 404 });
      const metaResponse = await project(env, projectId).fetch(
        new Request("https://project/meta"),
      );
      if (!metaResponse.ok) return new Response(null, { status: 404 });
      const meta = await metaResponse.json<any>();
      if (
        meta.status === "deleted" ||
        meta.kind !== "site" ||
        !env.ALLOWED_GUILD_IDS.split(",")
          .map((v) => v.trim())
          .includes(meta.guild_id)
      )
        return new Response(null, { status: 404 });
      const session = await authenticate(request, env, projectId);
      if (!session || session.guild !== meta.guild_id) return loginPage();
      // Origin check protects authenticated mutations; no cross-origin APIs or WebSockets.
      if (
        !["GET", "HEAD"].includes(request.method) &&
        request.headers.get("origin") !== url.origin
      )
        return new Response(null, { status: 403 });
      if (request.headers.get("upgrade"))
        return new Response(null, { status: 426 });
      if (url.pathname === "/_auth/me") return json({ user: session.user });
      const room = url.pathname.match(
        /^\/_(room|wordle)\/([a-zA-Z0-9_-]{1,64})$/,
      );
      if (url.pathname === "/_source") {
        if (session.user !== meta.owner)
          return new Response(null, { status: 403 });
        const source = await env.ARTIFACTS.get(
          `${projectId}/${meta.active}/artifact.json`,
        );
        return source
          ? new Response(JSON.stringify((await source.json<any>()).source), {
              headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
                "content-disposition": "attachment; filename=source.json",
              },
            })
          : new Response(null, { status: 404 });
      }
      if (room) {
        await project(env, projectId).fetch(
          new Request("https://project/room-index", {
            method: "POST",
            body: JSON.stringify({ room: room[1] + ":" + room[2] }),
          }),
        );
        const stub = env.ROOMS.get(
          env.ROOMS.idFromName(`${projectId}:${room[1]}:${room[2]}`),
        );
        return stub.fetch(
          new Request(
            "https://room/" + (room[1] === "wordle" ? "wordle" : "state"),
            {
              method: request.method,
              body: request.body,
              headers: {
                "content-type": "application/json",
                "x-player": session.user,
              },
            },
          ),
        );
      }
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      if (url.pathname.startsWith("/_"))
        return new Response(null, { status: 404 });
      if (!meta.active)
        return new Response("This app is still being built.", {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      let path: string;
      try {
        path = decodeURIComponent(url.pathname).slice(1) || "index.html";
      } catch {
        return new Response(null, { status: 400 });
      }
      if (path.split("/").some((p) => !p || p === "..") || path.includes("\\"))
        return new Response(null, { status: 400 });
      const file = await env.ARTIFACTS.get(
        `${projectId}/${meta.active}/public/${path}`,
      );
      if (!file) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : file.body, {
        headers: {
          "content-type":
            mime[path.split(".").at(-1)!] || "application/octet-stream",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          "permissions-policy": "camera=(), microphone=(), geolocation=()",
        },
      });
    } catch {
      return new Response("Service unavailable. Please try again.", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
  },
};
