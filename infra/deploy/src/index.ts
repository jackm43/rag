import { createRpcHandler, type RpcHandler } from "../../sdk/ts/src";
import { registerDeployServices } from "./services";
import type { Env } from "./types";

let cached: { env: Env; rpc: RpcHandler } | null = null;

const rpcHandler = (env: Env): RpcHandler => {
  if (cached?.env !== env) {
    cached = { env, rpc: createRpcHandler((router) => registerDeployServices(router, env)) };
  }
  return cached.rpc;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const rpcResponse = await rpcHandler(env)(request);
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
