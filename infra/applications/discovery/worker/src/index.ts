import {
  createRpcHandler,
  errorMessage,
  gatewayTraceExporter,
  logger,
  serviceCredentialFromEnv,
  traceRpc,
  tracerFromEnv,
} from "../../../../sdk/ts/src";
import { d1Store } from "./data";
import { registerDiscoveryServices } from "./services";
import { selfIdentity, syncRegistry } from "./sync";
import type { Env } from "./types";

type TracedRpc = (request: Request, ctx?: ExecutionContext) => Promise<Response | null>;

let cached: { env: Env; rpc: TracedRpc } | null = null;

const rpcHandler = (env: Env): TracedRpc => {
  if (cached?.env !== env) {
    const gatewayUrl = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
    const credential = serviceCredentialFromEnv(env);
    const exporter =
      credential && env.AUTH_GATEWAY
        ? gatewayTraceExporter({
          gatewayUrl,
          credential,
          fetch: (input: RequestInfo | URL, init?: RequestInit) => env.AUTH_GATEWAY!.fetch(input, init),
        })
        : undefined;
    cached = {
      env,
      rpc: traceRpc(
        tracerFromEnv(env, "discovery", { exporter }),
        createRpcHandler((router) => registerDiscoveryServices(router, env)),
      ),
    };
  }
  return cached.rpc;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const rpcResponse = await rpcHandler(env)(request, ctx);
    if (rpcResponse) {
      return rpcResponse;
    }
    if (new URL(request.url).pathname === "/" && request.method === "GET") {
      return new Response("ok");
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const identity = await selfIdentity(env);
          await syncRegistry(env, d1Store(env.DB), identity);
        } catch (error) {
          logger.error("discovery_sync_failed", { error: errorMessage(error) });
        }
      })(),
    );
  },
};
