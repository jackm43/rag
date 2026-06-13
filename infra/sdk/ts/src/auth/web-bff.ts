import type { ConnectorConfig } from "../client/connector";
import type { Identity } from "../identity";
import { loadServiceCredentialFromEnv, type ServiceCredential } from "../oauth2/credential";
import { annotateSpan, gatewayTraceExporter, traceRpc, tracerFromEnv } from "../otel";
import { logger } from "../logger";
import { sessionProxy, verifySessionRequest, type ProxyTarget } from "./proxy";

// Injected client-identity registrar. The generated idp service client
// (idp.clientIdentityServiceClient) is structurally assignable; injecting it
// keeps the SDK from depending on generated application code.
export type ClientIdentityRegistrar = (
  connection: Omit<ConnectorConfig, "application">,
  identity: Identity,
) => {
  registerClientIdentity(request: {
    application: string;
    instanceId: string;
    publicJwk: string;
    kind: string;
  }): Promise<{
    identity?: {
      instanceId: string;
      application: string;
      subject: string;
      email: string;
      kind: string;
      jkt: string;
      createdAt: bigint | number;
      expiresAt: bigint | number;
    };
    identityToken: string;
  }>;
};

const REGISTER_SCOPE = "idp/ClientIdentityService.RegisterClientIdentity";
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const INSTANCE_KIND_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

export type WebBffTarget = {
  audience: string;
  binding?: string;
  endpoint: string;
  scopes?: string[];
};

export type WebBffEnv = {
  ASSETS: Fetcher;
  AUTH_GATEWAY_URL: string;
  AUTH_GATEWAY?: Fetcher;
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string | { get(): Promise<string> };
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
};

export type WebBffConfig = {
  app: string;
  targets: WebBffTarget[];
  defaultInstanceKind?: string;
  registerPath?: string;
  // When set, /client/chats registers a per-instance client identity through
  // this factory (the generated idp client). Omit to disable registration.
  registerClient?: ClientIdentityRegistrar;
};

export const proxyTargetFor = (
  audience: string,
  target: { endpoint: string; scopes?: string[]; fetch?: typeof fetch },
): ProxyTarget => ({
  prefix: `/${audience}.v1.`,
  application: audience,
  ...target,
});

const bindingFetch = (binding: Fetcher | undefined): typeof fetch | undefined =>
  binding ? (input: RequestInfo | URL, init?: RequestInit) => binding.fetch(input, init) : undefined;

const readEnv = (env: WebBffEnv & Record<string, unknown>, key: string): string | undefined => {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const readBinding = (env: WebBffEnv & Record<string, unknown>, key: string | undefined): Fetcher | undefined => {
  if (!key) {
    return undefined;
  }
  const value = env[key];
  return value as Fetcher | undefined;
};

const registerInstance = async (
  app: string,
  defaultKind: string,
  registerClient: ClientIdentityRegistrar,
  config: {
    gatewayUrl: string;
    verify?: { jwksUrl: string; gatewayFetch?: typeof fetch };
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
  let kind = defaultKind;
  try {
    const body = (await request.json()) as { chatId?: string; publicJwk?: string; kind?: string };
    requested = body.chatId ?? "";
    publicJwk = body.publicJwk ?? "";
    if (body.kind && INSTANCE_KIND_PATTERN.test(body.kind)) {
      kind = body.kind;
    }
  } catch {
    // Empty body: mint an id, no key binding.
  }
  const actor = identity.email ?? identity.subject;
  try {
    const idp = registerClient(
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
      application: app,
      instanceId: INSTANCE_ID_PATTERN.test(requested) ? requested : "",
      publicJwk,
      kind,
    });
    const registered = result.identity!;
    annotateSpan({ actor, client_instance: registered.instanceId });
    logger.info(`${app}_instance_registered`, {
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
    logger.warn(`${app}_instance_registration_failed`, { actor, error: String(error) });
    return Response.json(
      { code: "unavailable", message: `${app} identity registration failed` },
      { status: 503 },
    );
  }
};

type Handler = (request: Request, ctx?: ExecutionContext) => Promise<Response | null>;

export const createWebBffWorker = (config: WebBffConfig) => {
  const registerPath = config.registerPath ?? "/client/chats";
  const defaultKind = config.defaultInstanceKind ?? config.app;
  const proxyPrefixes = [
    ...config.targets.map((target) => `/${target.audience}.v1.`),
    "/client/",
  ];

  let cached: { env: WebBffEnv; handler: Handler } | null = null;
  let credentialPromise: Promise<ServiceCredential | null> | null = null;

  const unavailableHandler = (): Handler => async (request) =>
    proxyPrefixes.some((prefix) => new URL(request.url).pathname.startsWith(prefix))
      ? new Response(
        JSON.stringify({ code: "unavailable", message: "service credential not configured" }),
        { status: 503, headers: { "content-type": "application/json" } },
      )
      : null;

  const proxyHandler = async (env: WebBffEnv & Record<string, unknown>): Promise<Handler> => {
    if (cached?.env === env) {
      return cached.handler;
    }
    credentialPromise ??= loadServiceCredentialFromEnv(env);
    const credential = await credentialPromise;
    if (!credential) {
      const handler = unavailableHandler();
      cached = { env, handler };
      return handler;
    }
    const issuer = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
    const tracer = tracerFromEnv(env, config.app, {
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
    const targets = config.targets.flatMap((target) => {
      const endpoint = readEnv(env, target.endpoint);
      if (!endpoint) {
        return [];
      }
      return [
        proxyTargetFor(target.audience, {
          endpoint,
          scopes: target.scopes,
          fetch: bindingFetch(readBinding(env, target.binding)),
        }),
      ];
    });
    const proxy = sessionProxy({
      gatewayUrl: issuer,
      credential,
      verify,
      gatewayFetch: bindingFetch(env.AUTH_GATEWAY),
      targets,
    });
    const registerClient = config.registerClient;
    const handler = traceRpc(tracer, async (request) => {
      const url = new URL(request.url);
      if (registerClient && url.pathname === registerPath && request.method === "POST") {
        return registerInstance(config.app, defaultKind, registerClient, {
          gatewayUrl: issuer,
          verify,
          credential,
          gatewayFetch: bindingFetch(env.AUTH_GATEWAY),
        }, request);
      }
      return proxy(request);
    });
    cached = { env, handler };
    return handler;
  };

  return {
    async fetch(request: Request, env: WebBffEnv & Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
      const proxied = await (await proxyHandler(env))(request, ctx);
      if (proxied) {
        return proxied;
      }
      return env.ASSETS.fetch(request);
    },
  };
};
