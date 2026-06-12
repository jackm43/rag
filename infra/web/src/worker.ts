import { proxyTarget as aigatewayTarget } from "../../applications/aigateway/service";
import { createClientIdentityServiceClient } from "../../applications/idp/service";
import { proxyTarget as ragbotTarget } from "../../applications/ragbot/service";
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
} from "../../sdk/ts/src";

// The chat application's worker: serves the static frontend and acts as the
// confidential web client (BFF) for the APIs its pages call. The browser
// stays a dumb public client — it sends its DPoP-bound session token plus a
// per-request proof to same-origin paths; this worker validates the sender
// constraint at the edge, chains the user's identity into an audience token
// for the target application (chat's service credential as actor, gated by
// its delegations), and forwards service-to-service. The target application
// always re-validates the audience token itself.

interface Env {
  ASSETS: Fetcher;
  AUTH_GATEWAY_URL: string;
  AUTH_GATEWAY?: Fetcher;
  AIGATEWAY?: Fetcher;
  AIGATEWAY_ENDPOINT: string;
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

const PROXY_PREFIXES = ["/aigateway.v1.", "/ragbot.v1.", "/client/"];

// Per-isolate view of registered chat instances; the durable identity is the
// chained tokens partitioned by instance id, this map only feeds diagnostics.
const chatInstances = new Map<string, { actor: string; createdAt: number }>();

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const REGISTER_SCOPE = "idp/ClientIdentityService.RegisterClientIdentity";

// POST /client/chats — federates the chat instance with the platform IdP:
// after validating the browser's session, the worker (acting as the chat
// application for the user, over its idp delegation) registers the instance
// with the gateway's ClientIdentityService — application audience, user
// subject, and the chat's public key — and returns the gateway-signed,
// key-bound identity document. The id becomes the client-instance header on
// that chat's requests (partitioned token chain, trace identity).
const registerChat = async (
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
  let kind = "chat";
  try {
    const body = (await request.json()) as { chatId?: string; publicJwk?: string; kind?: string };
    requested = body.chatId ?? "";
    publicJwk = body.publicJwk ?? "";
    // Instance kinds: "chat" conversations, "tracing" for the live trace
    // follower — any client this page runs under its own identity.
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
      application: "chat",
      instanceId: CHAT_ID_PATTERN.test(requested) ? requested : "",
      publicJwk,
      kind,
    });
    const registered = result.identity!;
    chatInstances.set(registered.instanceId, { actor, createdAt: Date.now() });
    annotateSpan({ actor, client_instance: registered.instanceId });
    logger.info("chat_registered", {
      chat: registered.instanceId,
      actor,
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
    logger.warn("chat_identity_registration_failed", { actor, error: String(error) });
    return Response.json(
      { code: "unavailable", message: "chat identity registration failed" },
      { status: 503 },
    );
  }
};

// Read-only ragbot RPCs surfaced in the web app's data panel; the chained
// token is scoped to exactly these (matching the chat → ragbot delegation).
const RAGBOT_SCOPES = [
  "ragbot/LeaderboardService.ListTotals",
  "ragbot/ConfigService.ListConfig",
  "ragbot/InteractionService.ListInteractions",
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
    const tracer = tracerFromEnv(env, "chat", {
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
      jwksFetch: bindingFetch(env.AUTH_GATEWAY),
    };
    const proxy = sessionProxy({
      gatewayUrl: issuer,
      credential,
      verify,
      gatewayFetch: bindingFetch(env.AUTH_GATEWAY),
      targets: [
        aigatewayTarget({
          endpoint: env.AIGATEWAY_ENDPOINT,
          fetch: bindingFetch(env.AIGATEWAY),
        }),
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
        return registerChat(
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
