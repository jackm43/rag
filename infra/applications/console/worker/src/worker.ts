import { proxyTarget as deployTarget } from "../../../deploy/service";
import { proxyTarget as discoveryTarget } from "../../../discovery/service";
import { createClientIdentityServiceClient } from "../../../idp/service";
import { proxyTarget as ragbotTarget } from "../../../ragbot/service";
import {
  annotateSpan,
  gatewayTraceExporter,
  logger,
  serviceCredentialFromEnv,
  sessionProxy,
  traceRpc,
  tracerFromEnv,
  verifySessionRequest,
  type ServiceCredential,
  type StsVerifierConfig,
} from "../../../../sdk/ts/src";

// The console application's worker: serves the static admin frontend and acts
// as the confidential web client (BFF) for the platform APIs its pages call.
// The browser stays a dumb public client - it sends its DPoP-bound session
// token plus a per-request proof to same-origin paths; this worker validates
// the sender constraint at the edge, chains the user's identity into an
// audience token for the target application (console's service credential as
// actor, gated by its delegations), and forwards service-to-service. Gateway
// paths (/idp.v1.*, /api/*) are zone-routed to the auth gateway directly.

interface Env {
  ASSETS: Fetcher;
  AUTH_GATEWAY_URL: string;
  AUTH_GATEWAY?: Fetcher;
  DEPLOY?: Fetcher;
  DEPLOY_ENDPOINT?: string;
  DISCOVERY?: Fetcher;
  DISCOVERY_ENDPOINT?: string;
  RAGBOT?: Fetcher;
  RAGBOT_ENDPOINT?: string;
  // Service credential pushed by `platy deploy` after registration.
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string;
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}

type Handler = (request: Request, ctx?: ExecutionContext) => Promise<Response | null>;

const PROXY_PREFIXES = ["/deploy.v1.", "/discovery.v1.", "/ragbot.v1.", "/client/"];

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const REGISTER_SCOPE = "idp/ClientIdentityService.RegisterClientIdentity";

// POST /client/chats - federates a page client instance with the platform
// IdP: after validating the browser's session, the worker (acting as the
// console application for the user, over its idp delegation) registers the
// instance with the gateway's ClientIdentityService and returns the
// gateway-signed, key-bound identity document. The console uses this for the
// live trace follower, which streams under its own registered identity.
const registerInstance = async (
  config: {
    gatewayUrl: string;
    verify?: Partial<StsVerifierConfig>;
    credential: ServiceCredential;
    gatewayFetch?: typeof fetch;
  },
  request: Request,
): Promise<Response> => {
  const identity = await verifySessionRequest(config, request);
  if (!identity) {
    return Response.json(
      { code: "unauthenticated", message: "a DPoP-bound session token is required" },
      { status: 401 },
    );
  }
  let requested = "";
  let publicJwk = "";
  let kind = "console";
  try {
    const body = (await request.json()) as { chatId?: string; publicJwk?: string; kind?: string };
    requested = body.chatId ?? "";
    publicJwk = body.publicJwk ?? "";
    if (body.kind && /^[a-z][a-z0-9-]{0,15}$/.test(body.kind)) {
      kind = body.kind;
    }
  } catch {
    // Empty body: mint an id, no key binding.
  }
  const actor = identity.email ?? identity.subject;
  try {
    const idp = createClientIdentityServiceClient(
      {
        endpoint: config.gatewayUrl,
        gatewayUrl: config.gatewayUrl,
        credential: config.credential,
        scopes: [REGISTER_SCOPE],
        gatewayFetch: config.gatewayFetch,
        fetch: config.gatewayFetch,
      },
      identity,
    );
    const result = await idp.registerClientIdentity({
      application: "console",
      instanceId: INSTANCE_ID_PATTERN.test(requested) ? requested : "",
      publicJwk,
      kind,
    });
    const registered = result.identity!;
    annotateSpan({ actor, client_instance: registered.instanceId });
    logger.info("console_instance_registered", {
      instance: registered.instanceId,
      actor,
      kind: registered.kind,
      jkt: registered.jkt,
      session: identity.sessionId ?? "",
    });
    return Response.json({
      chatId: registered.instanceId,
      actor,
      token: result.identityToken,
      identity: {
        instanceId: registered.instanceId,
        application: registered.application,
        subject: registered.subject,
        email: registered.email,
        kind: registered.kind,
        jkt: registered.jkt,
        createdAt: Number(registered.createdAt),
        expiresAt: Number(registered.expiresAt),
      },
    });
  } catch (error) {
    logger.warn("console_instance_registration_failed", { actor, error: String(error) });
    return Response.json(
      { code: "unavailable", message: "console identity registration failed" },
      { status: 503 },
    );
  }
};

// Chained tokens are scoped to exactly the RPCs each view uses, matching the
// console's delegations in the manifest.
const DEPLOY_SCOPES = [
  "deploy/DeployService.ListWorkers",
  "deploy/DeployService.DeployWorker",
];

const DISCOVERY_SCOPES = [
  "discovery/DiscoveryService.Query",
  "discovery/DiscoveryService.Sync",
];

const RAGBOT_SCOPES = [
  "ragbot/ConfigService.ListConfig",
  "ragbot/ConfigService.GetConfig",
  "ragbot/ConfigService.UpdateConfig",
  "ragbot/ConfigService.ResetConfig",
  "ragbot/GatewayControlService.GetHealth",
];

const bindingFetch = (binding: Fetcher | undefined): typeof fetch | undefined =>
  binding ? (input: RequestInfo | URL, init?: RequestInit) => binding.fetch(input, init) : undefined;

let cached: { env: Env; handler: Handler } | null = null;

const proxyHandler = (env: Env): Handler => {
  if (cached?.env === env) {
    return cached.handler;
  }
  const credential = serviceCredentialFromEnv(env);
  const issuer = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
  let handler: Handler;
  if (!credential) {
    // Registered but not yet deployed with its credential: fail closed on API
    // paths instead of letting them fall through to the SPA fallback.
    handler = async (request) =>
      PROXY_PREFIXES.some((prefix) => new URL(request.url).pathname.startsWith(prefix))
        ? new Response(
          JSON.stringify({ code: "unavailable", message: "service credential not configured" }),
          { status: 503, headers: { "content-type": "application/json" } },
        )
        : null;
  } else {
    const tracer = tracerFromEnv(env, "console", {
      exporter: env.AUTH_GATEWAY
        ? gatewayTraceExporter({
          gatewayUrl: issuer,
          credential,
          fetch: bindingFetch(env.AUTH_GATEWAY),
        })
        : undefined,
    });
    const verify = {
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      gatewayFetch: bindingFetch(env.AUTH_GATEWAY),
    };
    const proxy = sessionProxy({
      gatewayUrl: issuer,
      credential,
      verify,
      gatewayFetch: bindingFetch(env.AUTH_GATEWAY),
      targets: [
        ...(env.DEPLOY_ENDPOINT
          ? [
            deployTarget({
              endpoint: env.DEPLOY_ENDPOINT,
              scopes: DEPLOY_SCOPES,
              fetch: bindingFetch(env.DEPLOY),
            }),
          ]
          : []),
        ...(env.DISCOVERY_ENDPOINT
          ? [
            discoveryTarget({
              endpoint: env.DISCOVERY_ENDPOINT,
              scopes: DISCOVERY_SCOPES,
              fetch: bindingFetch(env.DISCOVERY),
            }),
          ]
          : []),
        ...(env.RAGBOT_ENDPOINT
          ? [
            ragbotTarget({
              endpoint: env.RAGBOT_ENDPOINT,
              scopes: RAGBOT_SCOPES,
              fetch: bindingFetch(env.RAGBOT),
            }),
          ]
          : []),
      ],
    });
    handler = traceRpc(tracer, async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/client/chats" && request.method === "POST") {
        return registerInstance(
          { gatewayUrl: issuer, verify, credential, gatewayFetch: bindingFetch(env.AUTH_GATEWAY) },
          request,
        );
      }
      return proxy(request);
    });
  }
  cached = { env, handler };
  return handler;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const proxied = await proxyHandler(env)(request, ctx);
    if (proxied) {
      return proxied;
    }
    // Everything else is the static frontend (run_worker_first only routes
    // API prefixes here, but dev setups may invoke the worker for any path).
    return env.ASSETS.fetch(request);
  },
};
