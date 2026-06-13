import { Code, ConnectError } from "@connectrpc/connect";

import {
  createRpcHandler,
  traceRpc,
  tracerFromEnv,
  verifyDpopProof,
  type RequestDescriptor,
} from "@platy/sdk";
import { getJwks } from "./keys";
import { completeProviderOAuthCallback } from "./provider-oauth";
import {
  authorizeIntrospectionCaller,
  buildAuthorizationServerMetadata,
  buildBootstrapDiscovery,
  createGatewaySession,
  exchangeGatewayToken,
  introspectToken,
  refreshGatewaySession,
  registerServices,
} from "./services";
import { handleDiscordAuthorize, handleDiscordCallback } from "./discord-oauth";
import { revokeSession } from "./sessions";
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

const oauthResponse = (body: unknown, status = 200, extraHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
      ...extraHeaders,
    },
  });

// A missing or malformed DPoP proof is an RFC 9449 protocol error, not a bad
// grant: answer 401 with a DPoP challenge so clients retry with a proof.
class DpopRequiredError extends Error { }

const oauthErrorCode = (error: unknown): { error: string; status: number; description: string } => {
  if (!(error instanceof ConnectError)) {
    return { error: "server_error", status: 500, description: String(error) };
  }
  const description = (error as ConnectError & { rawMessage?: string }).rawMessage ?? error.message;
  switch (error.code) {
    case Code.InvalidArgument:
      return { error: "invalid_request", status: 400, description };
    case Code.Unauthenticated:
      return { error: "invalid_grant", status: 400, description };
    case Code.PermissionDenied:
      return { error: "access_denied", status: 403, description };
    case Code.NotFound:
      return { error: "invalid_target", status: 400, description };
    case Code.FailedPrecondition:
      return { error: "unauthorized_client", status: 400, description };
    default:
      return { error: "server_error", status: 500, description };
  }
};

const basicClientCredential = (headers: Headers): string | null => {
  const header = headers.get("authorization") ?? "";
  const match = /^basic\s+(.+)$/i.exec(header);
  if (!match) {
    return null;
  }
  try {
    const decoded = atob(match[1]);
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return null;
    }
    return `${decodeURIComponent(decoded.slice(0, separator))}:${decodeURIComponent(decoded.slice(separator + 1))}`;
  } catch {
    return null;
  }
};

const tokenEndpointRequest = (request: Request): RequestDescriptor => ({
  method: request.method,
  url: request.url,
});

const requireOAuthDpop = async (request: Request): Promise<string> => {
  const proof = await verifyDpopProof(request.headers, tokenEndpointRequest(request));
  if (!proof) {
    throw new DpopRequiredError();
  }
  return proof.jkt;
};

const dpopChallengeResponse = (description: string): Response =>
  oauthResponse(
    { error: "invalid_dpop_proof", error_description: description },
    401,
    { "www-authenticate": 'DPoP error="invalid_dpop_proof", algs="ES256"' },
  );

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

const handleBootstrapDiscovery = (env: Env): Response => {
  const discovered = buildBootstrapDiscovery(env);
  return jsonResponse({
    endpoints: {
      token_exchange: discovered.endpoints.tokenExchange,
      token_revoke: discovered.endpoints.tokenRevoke,
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
    auth_providers: discovered.auth_providers,
  });
};

const scopeList = (params: URLSearchParams): string[] =>
  (params.get("scope") ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

const formClientCredential = (request: Request, params: URLSearchParams): string => {
  const basic = basicClientCredential(request.headers);
  if (basic) {
    return basic;
  }
  const clientId = params.get("client_id") ?? "";
  const clientSecret = params.get("client_secret") ?? "";
  return clientId && clientSecret ? `${clientId}:${clientSecret}` : "";
};

const handleOAuthToken = async (env: Env, request: Request): Promise<Response> => {
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get("content-type") ?? "")) {
    return oauthResponse(
      { error: "invalid_request", error_description: "token requests must use application/x-www-form-urlencoded" },
      400,
    );
  }
  const params = new URLSearchParams(await request.text());
  const grantType = params.get("grant_type") ?? "";
  try {
    if (grantType === "authorization_code") {
      const jkt = await requireOAuthDpop(request);
      const tokens = await createGatewaySession(
        env,
        {
          subjectToken: "",
          subjectTokenType: "",
          authorizationCode: params.get("code") ?? "",
          codeVerifier: params.get("code_verifier") ?? "",
          redirectUri: params.get("redirect_uri") ?? "",
        },
        jkt,
      );
      return oauthResponse({
        access_token: tokens.accessToken,
        token_type: tokens.tokenType,
        expires_in: Number(tokens.expiresIn),
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      });
    }

    if (grantType === "refresh_token") {
      const jkt = await requireOAuthDpop(request);
      const tokens = await refreshGatewaySession(
        env,
        { refreshToken: params.get("refresh_token") ?? "" },
        jkt,
      );
      return oauthResponse({
        access_token: tokens.accessToken,
        token_type: tokens.tokenType,
        expires_in: Number(tokens.expiresIn),
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      });
    }

    if (grantType === "urn:ietf:params:oauth:grant-type:token-exchange") {
      const actorToken = params.get("actor_token") ?? formClientCredential(request, params);
      const result = await exchangeGatewayToken(
        env,
        {
          subjectToken: params.get("subject_token") ?? "",
          subjectTokenType: params.get("subject_token_type") ?? "",
          actorToken,
          actorTokenType: actorToken
            ? params.get("actor_token_type") || "urn:platy:params:oauth:token-type:service-credential"
            : "",
          audience: params.get("audience") ?? params.get("resource") ?? "",
          scopes: scopeList(params),
          requestedTokenType: params.get("requested_token_type") ?? "",
          impersonationToken: params.get("impersonation_token") ?? "",
          impersonationTokenType: params.get("impersonation_token_type") ?? "",
        },
        { headers: request.headers, request: tokenEndpointRequest(request) },
      );
      return oauthResponse({
        access_token: result.accessToken,
        issued_token_type: result.issuedTokenType,
        token_type: result.tokenType,
        expires_in: Number(result.expiresIn),
        scope: result.scopes.join(" "),
      });
    }

    return oauthResponse(
      { error: "unsupported_grant_type", error_description: `unsupported grant_type ${grantType}` },
      400,
    );
  } catch (error) {
    if (error instanceof DpopRequiredError) {
      return dpopChallengeResponse("a valid DPoP proof is required for this grant");
    }
    const mapped = oauthErrorCode(error);
    return oauthResponse(
      { error: mapped.error, error_description: mapped.description },
      mapped.status,
    );
  }
};

const handleOAuthRevoke = async (env: Env, request: Request): Promise<Response> => {
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get("content-type") ?? "")) {
    return oauthResponse(
      { error: "invalid_request", error_description: "revocation requests must use application/x-www-form-urlencoded" },
      400,
    );
  }
  const params = new URLSearchParams(await request.text());
  const token = params.get("token") ?? params.get("refresh_token") ?? "";
  if (!token) {
    return oauthResponse({ error: "invalid_request", error_description: "token is required" }, 400);
  }
  // RFC 7009: only refresh tokens are revocable here. A hint of access_token (or
  // any unknown token) is a no-op success, and revoking an invalid token still
  // returns 200 with an empty body so clients cannot probe token validity.
  if ((params.get("token_type_hint") ?? "refresh_token") === "refresh_token") {
    await revokeSession(env, token);
  }
  return new Response(null, {
    status: 200,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
};

const handleOAuthIntrospect = async (env: Env, request: Request): Promise<Response> => {
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get("content-type") ?? "")) {
    return oauthResponse(
      { error: "invalid_request", error_description: "introspection requests must use application/x-www-form-urlencoded" },
      400,
    );
  }
  const authorized = await authorizeIntrospectionCaller(
    env,
    request.headers,
    tokenEndpointRequest(request),
  );
  if (!authorized) {
    return oauthResponse(
      { error: "invalid_token", error_description: "introspection requires an authorized caller" },
      401,
      { "www-authenticate": 'Bearer error="invalid_token"' },
    );
  }
  const params = new URLSearchParams(await request.text());
  const token = params.get("token") ?? "";
  return oauthResponse(await introspectToken(env, token));
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

    if (
      (url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration") &&
      request.method === "GET"
    ) {
      return withCors(jsonResponse(await buildAuthorizationServerMetadata(env)), cors);
    }

    if (url.pathname === "/api/discovery" && request.method === "GET") {
      if (url.searchParams.get("view") === "bootstrap") {
        return withCors(handleBootstrapDiscovery(env), cors);
      }
      return withCors(
        jsonResponse(
          {
            error: "unauthenticated",
            error_description:
              "full discovery requires authentication; use idp.v1.DiscoveryService.Discover or ?view=bootstrap",
          },
          401,
        ),
        cors,
      );
    }

    if (url.pathname === "/oauth/discord/authorize" && request.method === "GET") {
      return withCors(await handleDiscordAuthorize(env, request), cors);
    }

    if (url.pathname === "/oauth/discord/callback" && request.method === "GET") {
      return withCors(await handleDiscordCallback(env, request), cors);
    }

    if (url.pathname === "/oauth/token" && request.method === "POST") {
      return withCors(await handleOAuthToken(env, request), cors);
    }

    if (url.pathname === "/oauth/revoke" && request.method === "POST") {
      return withCors(await handleOAuthRevoke(env, request), cors);
    }

    if (url.pathname === "/oauth/introspect" && request.method === "POST") {
      return withCors(await handleOAuthIntrospect(env, request), cors);
    }

    if (url.pathname === "/v1/traces" && request.method === "POST") {
      return handleTraceIngest(env, request);
    }

    if (url.pathname === "/provider/oauth/callback" && request.method === "GET") {
      const query = url.searchParams;
      const code = query.get("code") ?? "";
      const state = query.get("state") ?? "";
      if (!code || !state) {
        return new Response("missing code or state", { status: 400 });
      }
      return withCors(await completeProviderOAuthCallback(env, code, state), cors);
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
