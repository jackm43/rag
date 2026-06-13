import type { ConnectRouter } from "@connectrpc/connect";

import { serviceCredentialFromEnv } from "./credential";
import { gatewayTraceExporter, traceRpc, tracerFromEnv, type Tracer } from "./otel";
import { createRpcHandler, type RpcHandler } from "./router";

type Fetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type PlatformRpcWorkerEnv = {
  AUTH_GATEWAY_URL?: string;
  AUTH_GATEWAY?: Fetcher;
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string;
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
};

export type PlatformRpcWorkerConfig<Env extends PlatformRpcWorkerEnv> = {
  serviceName: string;
  register: (router: ConnectRouter, env: Env, tracer: Tracer) => void;
  cors?: {
    originsEnv?: keyof Env & string;
    methods?: string;
    headers?: string;
  };
};

type CachedHandler<Env> = {
  env: Env;
  handler: (request: Request, ctx?: ExecutionContext) => Promise<Response | null>;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const bindingFetch = (binding: Fetcher | undefined): typeof fetch | undefined =>
  binding ? (input, init) => binding.fetch(input, init) : undefined;

const allowedOrigins = <Env extends PlatformRpcWorkerEnv>(
  env: Env,
  key: keyof Env & string,
): string[] =>
  String(env[key] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsHeaders = <Env extends PlatformRpcWorkerEnv>(
  env: Env,
  request: Request,
  config?: PlatformRpcWorkerConfig<Env>["cors"],
): Record<string, string> => {
  if (!config) {
    return {};
  }
  const origin = request.headers.get("origin");
  const originsEnv = config.originsEnv ?? ("ALLOWED_ORIGINS" as keyof Env & string);
  const origins = allowedOrigins(env, originsEnv);
  if (!origin || !origins.includes(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": config.methods ?? "POST, OPTIONS",
    "access-control-allow-headers":
      config.headers ??
      "authorization, dpop, content-type, connect-protocol-version, connect-timeout-ms, traceparent, x-client-instance, x-client-token",
    "access-control-max-age": "86400",
    vary: "origin",
  };
};

const withHeaders = (response: Response, headers: Record<string, string>): Response => {
  if (Object.keys(headers).length === 0) {
    return response;
  }
  const next = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    next.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers: next });
};

export const createPlatformRpcWorker = <Env extends PlatformRpcWorkerEnv>(
  config: PlatformRpcWorkerConfig<Env>,
) => {
  let cached: CachedHandler<Env> | null = null;

  const handler = (env: Env): CachedHandler<Env>["handler"] => {
    if (cached?.env === env) {
      return cached.handler;
    }
    const credential = serviceCredentialFromEnv(env);
    const gatewayUrl = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
    const exporter =
      credential && env.AUTH_GATEWAY
        ? gatewayTraceExporter({
            gatewayUrl,
            credential,
            fetch: bindingFetch(env.AUTH_GATEWAY),
          })
        : undefined;
    const tracer = tracerFromEnv(env, config.serviceName, { exporter });
    cached = {
      env,
      handler: traceRpc(
        tracer,
        createRpcHandler((router) => config.register(router, env, tracer)),
      ),
    };
    return cached.handler;
  };

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const cors = corsHeaders(env, request, config.cors);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      const rpc = await handler(env)(request, ctx);
      if (rpc) {
        return withHeaders(rpc, cors);
      }
      if (new URL(request.url).pathname === "/" && request.method === "GET") {
        return withHeaders(new Response("ok"), cors);
      }
      return withHeaders(jsonResponse({ error: "not found" }, 404), cors);
    },
  };
};
