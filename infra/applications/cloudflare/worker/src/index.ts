import {
  createRpcHandler,
  gatewayTraceExporter,
  serviceCredentialFromEnv,
  traceRpc,
  tracerFromEnv,
} from "../../../../sdk/ts/src";
import { registerCloudflareServices } from "./services";
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
        tracerFromEnv(env, "cloudflare", { exporter }),
        createRpcHandler((router) => registerCloudflareServices(router, env)),
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
};
