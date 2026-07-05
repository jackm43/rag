import { logger } from "@rag/logger";
import {
  defaultClientHandlers,
  type ClientHandler,
} from "./client-handlers";
import type { ClientKind, EdgeEnv, Principal } from "./types";

// The one shared fetch handler for every public application worker. An app is
// its route table plus config; the shell owns the invariants:
//   - discovery is public: /health, /openapi.json, and /.well-known/* answer
//     without authentication so unauthenticated clients can discover the surface;
//   - every other route is authenticated by its declared client kind, verified,
//     and authorized by the auth worker BEFORE the handler runs;
//   - unknown path → 404, known path / wrong method → 405 with an accurate Allow.
// Backends trust the auth decision and never re-check it.

export type RouteContext<Env extends EdgeEnv> = {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  params: Record<string, string>;
  principal: Principal;
};

export type AppRoute<Env extends EdgeEnv> = {
  method: string;
  // OpenAPI-style path template, e.g. "/api/connectors/{id}".
  path: string;
  operationId: string;
  // The authorization action the auth worker's policy table keys on.
  action: string;
  clientKind: ClientKind;
  handler: (context: RouteContext<Env>) => Response | Promise<Response>;
};

export type AppWorkerConfig<Env extends EdgeEnv> = {
  service: string;
  routes: Array<AppRoute<Env>>;
  // Generated OpenAPI document served at /openapi.json (authenticated-route
  // discovery). Optional so internal-only apps can omit it.
  openapi?: unknown;
  // Documents served under /.well-known/<name> for unauthenticated discovery.
  discovery?: Record<string, unknown>;
  // Override or extend the built-in client handlers (e.g. supply the webhook
  // verifier). Defaults cover `web` and `native`.
  clients?: Partial<Record<ClientKind, ClientHandler<Env>>>;
  // Run before any route (not discovery) — a cheap perimeter check, if any.
  guard?: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response | null>;
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// Compile "/api/x/{id}" into a matcher capturing named params. Anchored, exact
// segment count — no accidental prefix matches.
type CompiledRoute<Env extends EdgeEnv> = AppRoute<Env> & {
  pattern: RegExp;
  paramNames: string[];
};

const compile = <Env extends EdgeEnv>(route: AppRoute<Env>): CompiledRoute<Env> => {
  const paramNames: string[] = [];
  const source = route.path
    .split("/")
    .map((segment) => {
      const param = segment.match(/^\{([^}]+)\}$/);
      if (param) {
        paramNames.push(param[1]);
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { ...route, paramNames, pattern: new RegExp(`^${source}$`) };
};

export const createAppWorker = <Env extends EdgeEnv>(
  config: AppWorkerConfig<Env>,
): ExportedHandler<Env> => {
  const compiled = config.routes.map(compile);
  const handlers = { ...defaultClientHandlers<Env>(), ...config.clients };

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      // --- Public discovery (no auth) ---------------------------------------
      if (request.method === "GET" && url.pathname === "/health") {
        return json(200, { ok: true, service: config.service });
      }
      if (config.openapi !== undefined && request.method === "GET" && url.pathname === "/openapi.json") {
        return json(200, config.openapi);
      }
      if (config.discovery && request.method === "GET" && url.pathname.startsWith("/.well-known/")) {
        const name = url.pathname.slice("/.well-known/".length);
        const doc = config.discovery[name];
        if (doc !== undefined) {
          return json(200, doc);
        }
      }

      if (config.guard) {
        const denial = await config.guard(request, env, ctx);
        if (denial) {
          return denial;
        }
      }

      // --- Route match ------------------------------------------------------
      const onPath = compiled.filter((route) => route.pattern.test(url.pathname));
      if (onPath.length === 0) {
        return new Response("Not found", { status: 404 });
      }
      const route = onPath.find((candidate) => candidate.method === request.method);
      if (!route) {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: onPath.map((candidate) => candidate.method).join(", ") },
        });
      }

      // --- Authenticate → verify → authorize (auth worker owns all three) ---
      const handler = handlers[route.clientKind];
      const authn = await handler({
        request,
        env,
        app: config.service,
        action: route.action,
        route: route.path,
      });
      if (!authn.ok) {
        return authn.response;
      }
      const { principal } = authn;

      const verified = await env.AUTH.verify(principal);
      if (!verified.ok) {
        logger.warn("edge_verify_denied", { app: config.service, action: route.action, reason: verified.reason });
        return new Response("Unauthorized", { status: 401 });
      }

      const authorized = await env.AUTH.authorize({
        principal,
        app: config.service,
        action: route.action,
        route: route.path,
      });
      if (!authorized.ok) {
        logger.warn("edge_authz_denied", {
          app: config.service,
          action: route.action,
          subject: principal.subject,
          reason: authorized.reason,
        });
        return new Response("Forbidden", { status: authorized.status ?? 403 });
      }

      // --- Dispatch ---------------------------------------------------------
      const match = route.pattern.exec(url.pathname);
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(match?.[index + 1] ?? "");
      });
      return route.handler({ request, env, ctx, params, principal });
    },
  };
};

// Cap a request body before and after buffering so an accepted body always fits
// the queue/RPC it is headed for. Ported from the old edge harness.
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
