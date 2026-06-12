import { createRpcHandler, traceRpc, tracerFromEnv } from "../../sdk/ts/src";
import { getJwks } from "./keys";
import { buildDiscovery, registerServices } from "./services";
import { handleTraceIngest, localSpanSink } from "./traces";
import { SigningKeys } from "./keys";
import type { Env } from "./types";

export { SigningKeys };

type TracedRpc = (request: Request, ctx?: ExecutionContext) => Promise<Response | null>;

let cached: { env: Env; rpc: TracedRpc } | null = null;

const rpcHandler = (env: Env): TracedRpc => {
  if (cached?.env !== env) {
    // The gateway exports its own spans straight to the trace store in D1.
    const tracer = tracerFromEnv(env, "auth-gateway", { exporter: localSpanSink(env) });
    cached = {
      env,
      rpc: traceRpc(tracer, createRpcHandler((router) => registerServices(router, env))),
    };
  }
  return cached.rpc;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// Web clients (Module 3) run the session and token-exchange flows from the
// browser, so the gateway must answer CORS preflight and echo allowed origins.
// Origins are configured per-deployment; an unlisted origin gets no CORS
// headers and the browser blocks it, while the RPC auth itself is unchanged.
const allowedOrigins = (env: Env): string[] =>
  (env.GATEWAY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsHeaders = (env: Env, request: Request): Record<string, string> => {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(env).includes(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "authorization, dpop, content-type, connect-protocol-version, connect-timeout-ms, traceparent, x-client-instance, x-client-token",
    "access-control-max-age": "86400",
    vary: "origin",
  };
};

const withCors = (response: Response, cors: Record<string, string>): Response => {
  if (Object.keys(cors).length === 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
};

const handleDiscovery = async (env: Env): Promise<Response> => {
  const discovered = await buildDiscovery(env);
  return jsonResponse({
    issuer: discovered.issuer,
    jwks_uri: discovered.jwksUri,
    token_exchange_endpoint: discovered.endpoints.tokenExchange,
    endpoints: {
      token_exchange: discovered.endpoints.tokenExchange,
      session_create: discovered.endpoints.sessionCreate,
      session_refresh: discovered.endpoints.sessionRefresh,
      session_revoke: discovered.endpoints.sessionRevoke,
      introspect: discovered.endpoints.introspect,
      discovery: discovered.endpoints.discovery,
      jwks: discovered.endpoints.jwks,
    },
    oidc: {
      issuer: discovered.oidc.issuer,
      client_id: discovered.oidc.clientId,
      authorization_endpoint: discovered.oidc.authorizationEndpoint,
      token_endpoint: discovered.oidc.tokenEndpoint,
      jwks_endpoint: discovered.oidc.jwksEndpoint,
    },
    provider: discovered.provider,
    applications: discovered.applications.map((app) => ({
      name: app.name,
      audience: app.audience,
      endpoint: app.endpoint,
      description: app.description,
      resources: app.resources,
      delegations: app.delegations,
      provider: app.provider,
      trust_boundary: app.trustBoundary,
      access: app.access,
      impersonation_access_client_id: app.impersonationAccessClientId,
      created_at: Number(app.createdAt),
      updated_at: Number(app.updatedAt),
    })),
  });
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/.well-known/jwks.json" && request.method === "GET") {
      return withCors(await getJwks(env), cors);
    }

    if (url.pathname === "/api/discovery" && request.method === "GET") {
      return withCors(await handleDiscovery(env), cors);
    }

    if (url.pathname === "/v1/traces" && request.method === "POST") {
      return handleTraceIngest(env, request);
    }

    const rpcResponse = await rpcHandler(env)(request, ctx);
    if (rpcResponse) {
      return withCors(rpcResponse, cors);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("ok");
    }

    return jsonResponse({ error: "not found" }, 404);
  },
};
