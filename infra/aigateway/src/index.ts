import {
  createRpcHandler,
  gatewayTraceExporter,
  serviceCredentialFromEnv,
  traceRpc,
  tracerFromEnv,
  type Tracer,
} from "../../sdk/ts/src";
import { registerAiGatewayServices } from "./services";
import type { Env } from "./types";

type TracedRpc = (request: Request, ctx?: ExecutionContext) => Promise<Response | null>;

let cached: { env: Env; rpc: TracedRpc; tracer: Tracer } | null = null;

// Spans export to the gateway's trace store, authenticated with this
// worker's service credential over the gateway service binding.
const traceExporter = (env: Env) => {
  const credential = serviceCredentialFromEnv(env);
  return credential && env.AUTH_GATEWAY
    ? gatewayTraceExporter({
        gatewayUrl: env.AUTH_GATEWAY_URL ?? "",
        credential,
        fetch: (input: RequestInfo | URL, init?: RequestInit) => env.AUTH_GATEWAY!.fetch(input, init),
      })
    : undefined;
};

const rpcHandler = (env: Env): TracedRpc => {
  if (cached?.env !== env) {
    const tracer = tracerFromEnv(env, "aigateway", { exporter: traceExporter(env) });
    cached = {
      env,
      tracer,
      rpc: traceRpc(
        tracer,
        createRpcHandler((router) => registerAiGatewayServices(router, env, tracer)),
      ),
    };
  }
  return cached.rpc;
};

const allowedOrigins = (env: Env): string[] =>
  (env.AIG_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

// Browser clients call the Connect surface directly with a DPoP-bound token, so
// the worker must answer CORS preflight and echo an allowed origin. Origins are
// configured per-deployment; a request from an unlisted origin gets no CORS
// headers (the browser blocks it) but the RPC itself still authenticates.
const corsHeaders = (env: Env, request: Request): Record<string, string> => {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(env).includes(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const rpcResponse = await rpcHandler(env)(request, ctx);
    if (rpcResponse) {
      return withCors(rpcResponse, cors);
    }

    if (new URL(request.url).pathname === "/" && request.method === "GET") {
      return new Response("ok");
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
};
