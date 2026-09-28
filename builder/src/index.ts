import { WorkerEntrypoint } from "cloudflare:workers";
import { authRoute, currentMember, loginPage, page } from "./auth";
import { directory } from "./directory";
import { roomName } from "./rooms";
import {
  type Env,
  type Member,
  type Scope,
  allowedGuild,
  allowedGuilds,
  idPattern,
  json,
  project,
  snowflake,
  validScope,
} from "./types";

export { ContainerProxy } from "@cloudflare/containers";
export { Auth } from "./auth";
export { Directory } from "./directory";
export { BuildContainer, Project } from "./project";
export { Rooms } from "./rooms";

type Request_ = Scope & { id: string };

// Reachable only through the bot's service binding; the public fetch handler
// below exposes no way to create or control builds.
export class BuilderControl extends WorkerEntrypoint<Env> {
  private target(input: Request_) {
    if (!validScope(this.env, input) || !idPattern.test(input.id))
      throw new Error("invalid_scope");
    const scope: Scope = {
      guild_id: input.guild_id,
      channel_id: input.channel_id,
      user_id: input.user_id,
      moderator: input.moderator === true,
    };
    return { stub: project(this.env, input.id), scope };
  }

  async submit(input: Request_ & { prompt: string }) {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt || prompt.length > 6000) throw new Error("invalid_prompt");
    const { stub, scope } = this.target(input);
    return stub.submit(scope, input.id, prompt);
  }

  async status(input: Request_) {
    const { stub, scope } = this.target(input);
    return stub.status(scope);
  }

  async edit(input: Request_ & { prompt: string; operation: string }) {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt || prompt.length > 6000 || !snowflake.test(input.operation))
      throw new Error("invalid_prompt");
    const { stub, scope } = this.target(input);
    return stub.edit(scope, prompt, input.operation);
  }

  async cancel(input: Request_) {
    const { stub, scope } = this.target(input);
    return stub.cancel(scope);
  }

  async rollback(input: Request_ & { revision: number }) {
    if (!Number.isSafeInteger(input.revision))
      throw new Error("unknown_release");
    const { stub, scope } = this.target(input);
    return stub.rollback(scope, input.revision);
  }

  async delete(input: Request_) {
    const { stub, scope } = this.target(input);
    return stub.delete(scope);
  }
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
};

// Apps share this origin; every response keeps them to it at runtime.
const APP_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://cdn.discordapp.com; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()",
};

const notFound = () => new Response(null, { status: 404 });
const wantsPage = (request: Request) =>
  request.method === "GET" &&
  (request.headers.get("accept") ?? "").includes("text/html");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.host !== new URL(env.APP_ORIGIN).host)
      return notFound();
    try {
      return (
        (await authRoute(request, env)) ?? (await route(request, env, url))
      );
    } catch {
      return new Response("Something went wrong. Try again in a moment.", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
  },
};

async function route(request: Request, env: Env, url: URL) {
  if (url.pathname === "/") return hub(request, env);
  const match = url.pathname.match(/^\/([a-z0-9-]{3,48})(\/.*)?$/);
  const id = match && (await directory(env).resolve(match[1]));
  const meta = id && (await project(env, id).meta());
  if (
    !match ||
    !id ||
    !meta ||
    meta.status === "deleted" ||
    !allowedGuild(env, meta.guild_id)
  )
    return notFound();
  const [, slug, rest] = match;
  // Relative asset URLs need the trailing slash.
  if (!rest)
    return Response.redirect(`${url.origin}/${slug}/${url.search}`, 308);
  const member = await currentMember(request, env, meta.guild_id);
  if (!member)
    return wantsPage(request)
      ? loginPage(url.pathname + url.search)
      : json({ error: "unauthorized" }, 401);
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const safe =
    (request.method === "GET" || request.method === "HEAD") && !upgrade;
  // Cross-site pages cannot drive the API with the member's cookie.
  if (!safe && request.headers.get("origin") !== url.origin)
    return new Response(null, { status: 403 });
  if (rest === "/_api/me") return json(member);
  const room = rest.match(/^\/_api\/rooms\/([^/]+)$/);
  if (room && roomName.test(room[1]))
    return rooms(request, env, id, meta.active, room[1], member);
  if (rest.startsWith("/_api/")) return notFound();
  if (!safe) return new Response(null, { status: 405 });
  if (!meta.active)
    return page(
      "Still building",
      `<div class="center"><h1>Still building</h1><p>This app is not ready yet. Ragbot will post in Discord when it is.</p></div>`,
      503,
    );
  return asset(request, env, id, meta.active, rest);
}

function rooms(
  request: Request,
  env: Env,
  id: string,
  revision: number | undefined,
  name: string,
  member: Member,
) {
  // Identity and the live revision (whose server logic runs) come only from here.
  const forwarded = new Request(`https://rooms/${name}`, request);
  forwarded.headers.set("x-member", JSON.stringify(member));
  forwarded.headers.set("x-app", id);
  forwarded.headers.set("x-revision", String(revision ?? 0));
  return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(forwarded);
}

async function asset(
  request: Request,
  env: Env,
  id: string,
  revision: number,
  rest: string,
) {
  let path: string;
  try {
    path = decodeURIComponent(rest.slice(1));
  } catch {
    return notFound();
  }
  if (!path || path.endsWith("/")) path += "index.html";
  if (path.split("/").some((part) => !part || part === "." || part === ".."))
    return notFound();
  const object = await env.ARTIFACTS.get(`${id}/${revision}/site/${path}`, {
    onlyIf: request.headers,
  });
  if (!object) return notFound();
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const headers = new Headers(APP_HEADERS);
  headers.set("content-type", TYPES[extension] ?? "application/octet-stream");
  headers.set("etag", object.httpEtag);
  // Vite fingerprints everything under assets/; other files are revalidated.
  headers.set(
    "cache-control",
    path.startsWith("assets/")
      ? "private, max-age=31536000, immutable"
      : "private, no-cache",
  );
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers,
  });
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function hub(request: Request, env: Env) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  const guilds: string[] = [];
  let member: Member | null = null;
  for (const guild of allowedGuilds(env)) {
    const found = await currentMember(request, env, guild);
    if (found) {
      guilds.push(guild);
      member ??= found;
    }
  }
  if (!member) return loginPage("/");
  const apps = await directory(env).list(guilds);
  const items = apps.length
    ? apps
        .map(
          (app) =>
            `<li><a href="/${app.slug}/">${escape(app.title)}</a><p>${escape(app.summary.slice(0, 280))}</p></li>`,
        )
        .join("")
    : `<li><p>No apps yet. In Discord, mention Ragbot with <b>build</b> and describe one.</p></li>`;
  return page(
    "Server apps",
    `<header><h1>Server apps</h1><form method="post" action="/_auth/logout"><button>Sign out ${escape(member.name)}</button></form></header><ul>${items}</ul>`,
  );
}
