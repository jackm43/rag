import { createRpcHandler, type RpcHandler } from "../../sdk/ts/src";
import { getJwks } from "./keys";
import { registerServices, buildDiscovery } from "./services";
import { SigningKeys } from "./keys";
import type { Env } from "./types";

export { SigningKeys };

let cached: { env: Env; rpc: RpcHandler } | null = null;

const rpcHandler = (env: Env): RpcHandler => {
  if (cached?.env !== env) {
    cached = { env, rpc: createRpcHandler((router) => registerServices(router, env)) };
  }
  return cached.rpc;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

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
      who_am_i: discovered.endpoints.whoAmI,
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/jwks.json" && request.method === "GET") {
      return getJwks(env);
    }

    if (url.pathname === "/api/discovery" && request.method === "GET") {
      return handleDiscovery(env);
    }

    const rpcResponse = await rpcHandler(env)(request);
    if (rpcResponse) {
      return rpcResponse;
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("ok");
    }

    return jsonResponse({ error: "not found" }, 404);
  },
};
