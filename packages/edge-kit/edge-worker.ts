// The generic edge harness for workers whose authentication is inline and
// signature-based (e.g. the webhooks worker: Discord Ed25519, provider HMAC),
// rather than delegated to the auth worker. It is the routing shell only —
// serve /health and /openapi.json, run an optional perimeter guard, dispatch
// exact-or-pattern routes with automatic 405s, and fall through to 404. No
// manifest registration, no signing (those left with service-kit).
import { jsonResponse } from "./app-worker";

// Base64 exact body bytes, chunked to stay within String.fromCharCode limits.
export const base64Of = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
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
  // Method-agnostic handler (wins over `methods` when both are set).
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
  openapi?: unknown;
  // Perimeter check run before ANY route, including health/openapi. Returns a
  // Response to short-circuit.
  guard?: (request: Request, env: TEnv, ctx: ExecutionContext) => Promise<Response | null>;
  routes: Array<EdgeRoute<TEnv>>;
};

export const createEdgeWorker = <TEnv>(config: EdgeWorkerConfig<TEnv>) => ({
  async fetch(request: Request, env: TEnv, ctx: ExecutionContext): Promise<Response> {
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
