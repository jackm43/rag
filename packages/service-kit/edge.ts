// The shared edge harness for application middleware_client workers. Every
// application edge worker is the same shell: register the manifest, run an
// optional perimeter guard, serve /health and /openapi.json, dispatch exact
// or pattern routes with automatic 405s, and fall through to a bare 404.
// Centralising the shell makes those invariants unforgeable rather than
// copied per application — a new application's edge worker is routes + config.
import { createClient } from "./client";
import type { ServiceManifest } from "./manifest";
import { ensureRegistered } from "./registry";
import type { ServiceKitEnv } from "./env";
import type { MachinePrincipal } from "./principal";
import type { ServiceMessageBytes } from "@rag/contracts-core";

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// Base64 exact body bytes (signatures cover exact bytes, so bodies must cross
// service hops without re-encoding). Chunked to stay within
// String.fromCharCode's argument limits.
export const base64Of = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

// Cap a raw request body BEFORE buffering (content-length) and after (actual
// bytes) so an accepted body always fits the queue envelope it is headed for.
export const readCappedBody = async (
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | Response> => {
  const declaredLength = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return new Response("Payload too large", { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    return new Response("Payload too large", { status: 413 });
  }
  return bytes;
};

export type EdgeHandler<TEnv> = (
  request: Request,
  env: TEnv,
  ctx: ExecutionContext,
  params: string[],
) => Response | Promise<Response>;

export type EdgeRoute<TEnv> = {
  // Exact pathname, or a matcher returning captured params (null = no match).
  match: string | ((url: URL) => string[] | null);
  // Per-method handlers; a matched path with no handler for the method is 405
  // with an accurate Allow header.
  methods?: Record<string, EdgeHandler<TEnv>>;
  // Method-agnostic handler (e.g. a sub-router owning /api/auth/*). Wins over
  // `methods` when both are set.
  handler?: EdgeHandler<TEnv>;
};

export const pathPattern = (pattern: RegExp) => (url: URL): string[] | null => {
  const match = url.pathname.match(pattern);
  return match ? match.slice(1) : null;
};

export const pathPrefix = (prefix: string) => (url: URL): string[] | null =>
  url.pathname.startsWith(prefix) ? [] : null;

export type EdgeWorkerConfig<TEnv> = {
  service: string;
  manifest: ServiceManifest;
  openapi?: unknown;
  // Perimeter check run before ANY route, including health/openapi (e.g.
  // Cloudflare Access on the registry). Returns a Response to short-circuit.
  guard?: (request: Request, env: TEnv, ctx: ExecutionContext) => Promise<Response | null>;
  routes: Array<EdgeRoute<TEnv>>;
};

export const createEdgeWorker = <TEnv extends ServiceKitEnv>(config: EdgeWorkerConfig<TEnv>) => ({
  async fetch(request: Request, env: TEnv, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureRegistered(env, config.manifest));
    if (config.guard) {
      const denial = await config.guard(request, env, ctx);
      if (denial) {
        return denial;
      }
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, { ok: true, service: config.service });
    }
    if (config.openapi !== undefined && request.method === "GET" && url.pathname === "/openapi.json") {
      return jsonResponse(200, config.openapi);
    }
    for (const route of config.routes) {
      const params =
        typeof route.match === "string"
          ? url.pathname === route.match
            ? []
            : null
          : route.match(url);
      if (params === null) {
        continue;
      }
      if (route.handler) {
        return route.handler(request, env, ctx, params);
      }
      const handler = route.methods?.[request.method];
      if (!handler) {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: Object.keys(route.methods ?? {}).join(", ") },
        });
      }
      return handler(request, env, ctx, params);
    }
    return new Response("Not found", { status: 404 });
  },
});

// The one signed hop every application edge makes: register, frame the
// envelope as an on-behalf-of ServiceMessage (edge -> application trust), and
// hand back the bytes for the loopback service binding's invoke().
export const prepareApplicationHop = async (options: {
  env: ServiceKitEnv;
  self: MachinePrincipal;
  target: MachinePrincipal;
  subject: string;
  manifest: ServiceManifest;
  envelope: Uint8Array;
}): Promise<ServiceMessageBytes> => {
  await ensureRegistered(options.env, options.manifest);
  return createClient({
    env: options.env,
    self: options.self,
    context: { subject: options.subject },
    transportTrust: "trusted",
  })
    .to(options.target)
    .prepare(options.envelope);
};
