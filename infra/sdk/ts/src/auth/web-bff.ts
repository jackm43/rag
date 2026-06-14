import type { ConnectorConfig } from "../client/connector";
import type { Identity } from "../identity";
import { loadServiceCredentialFromEnv, type ServiceCredential } from "../oauth2/credential";
import { annotateSpan, gatewayTraceExporter, traceRpc, tracerFromEnv } from "../otel";
import { logger } from "../logger";
import { createPlatformAuthClient } from "../client/platform-auth";
import { DEVICE_JKT_HEADER } from "../http/tokens";
import { verifyDpopProof } from "../oauth2/dpop";
import { verifySessionRequest } from "./proxy";
import { createPlatformHonoApp } from "../http/app";
import { serviceBindingFetch } from "../transport";

export type ClientIdentityRegistrar = (
  connection: Omit<ConnectorConfig, "application">,
  identity: Identity,
) => unknown;

type ClientIdentityRegistrarClient = {
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
  prefixes?: string[];
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
  registerClient?: ClientIdentityRegistrar;
};

const SESSION_TOKEN_PATH = "/client/session/token";
const SESSION_REVOKE_PATH = "/client/session/revoke";

const basicServiceAuth = (credential: ServiceCredential): string =>
  `Basic ${btoa(`${credential.clientId}:${credential.clientSecret}`)}`;

const forwardSessionToken = async (
  request: Request,
  issuer: string,
  credential: ServiceCredential,
  gatewayFetch: typeof fetch,
): Promise<Response> => {
  const proof = await verifyDpopProof(request.headers, {
    method: request.method,
    url: request.url,
  });
  if (!proof) {
    return Response.json(
      { error: "invalid_dpop_proof", error_description: "a valid DPoP proof is required" },
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  const response = await gatewayFetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicServiceAuth(credential),
      [DEVICE_JKT_HEADER]: proof.jkt,
    },
    body: await request.text(),
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
};

const forwardSessionRevoke = async (
  request: Request,
  issuer: string,
  gatewayFetch: typeof fetch,
): Promise<Response> => {
  const response = await gatewayFetch(`${issuer}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: await request.text(),
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
};

const readEnv = (env: WebBffEnv & Record<string, unknown>, key: string): string | undefined => {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const readBinding = (env: WebBffEnv & Record<string, unknown>, key: string | undefined): Fetcher | undefined => {
  if (!key) {
    return undefined;
  }
  return env[key] as Fetcher | undefined;
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
    ) as ClientIdentityRegistrarClient;
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

const proxyPrefixes = (targets: WebBffTarget[]): string[] =>
  targets.flatMap((target) => target.prefixes ?? [`/platform/${target.audience}/v1/`]);

const isBffPath = (pathname: string, registerPath: string, prefixes: string[]): boolean =>
  pathname === registerPath
  || pathname === SESSION_TOKEN_PATH
  || pathname === SESSION_REVOKE_PATH
  || prefixes.some((prefix) => pathname.startsWith(prefix));

export const createWebBffWorker = (config: WebBffConfig) => {
  const registerPath = config.registerPath ?? "/client/chats";
  const defaultKind = config.defaultInstanceKind ?? config.app;
  const prefixes = proxyPrefixes(config.targets);

  let cached: {
    env: WebBffEnv;
    app: ReturnType<typeof createPlatformHonoApp<WebBffEnv>>;
    traced: (request: Request, ctx?: ExecutionContext) => Promise<Response | null>;
  } | null = null;
  let credentialPromise: Promise<ServiceCredential | null> | null = null;

  const unavailable = (): Response =>
    new Response(
      JSON.stringify({ code: "unavailable", message: "service credential not configured" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );

  const buildApp = async (env: WebBffEnv & Record<string, unknown>) => {
    if (cached?.env === env) {
      return cached;
    }
    credentialPromise ??= loadServiceCredentialFromEnv(env);
    const credential = await credentialPromise;
    const app = createPlatformHonoApp<WebBffEnv>({ application: config.app });
    if (!credential) {
      app.all("*", () => unavailable());
      const traced = traceRpc(tracerFromEnv(env, config.app), async (request) => {
        const response = await app.fetch(request, env);
        return response.status === 404 ? null : response;
      });
      cached = { env, app, traced };
      return cached;
    }
    const issuer = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
    const gatewayFetch = serviceBindingFetch(env.AUTH_GATEWAY, "AUTH_GATEWAY");
    const tracer = tracerFromEnv(env, config.app, {
      exporter: gatewayTraceExporter({
        gatewayUrl: issuer,
        credential,
        fetch: gatewayFetch,
      }),
    });
    const verify = {
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      gatewayFetch,
    };
    const targets = config.targets.flatMap((target) => {
      const endpoint = readEnv(env, target.endpoint);
      if (!endpoint) {
        return [];
      }
      return [{
        audience: target.audience,
        endpoint,
        scopes: target.scopes,
        prefixes: target.prefixes,
        bindingName: target.binding,
        fetch: serviceBindingFetch(readBinding(env, target.binding), target.binding),
      }];
    });
    const authClient = createPlatformAuthClient({
      application: config.app,
      gatewayUrl: issuer,
      credential,
      verify,
      gatewayFetch,
      targets,
    });
    const proxy = authClient.proxy;
    if (!proxy) {
      throw new Error(`bff ${config.app} has no proxy targets configured`);
    }
    const registerClient = config.registerClient;
    app.post(SESSION_TOKEN_PATH, async (c) =>
      forwardSessionToken(c.req.raw, issuer, credential, gatewayFetch),
    );
    app.post(SESSION_REVOKE_PATH, async (c) =>
      forwardSessionRevoke(c.req.raw, issuer, gatewayFetch),
    );
    if (registerClient) {
      app.post(registerPath, async (c) =>
        registerInstance(config.app, defaultKind, registerClient, {
          gatewayUrl: issuer,
          verify,
          credential,
          gatewayFetch,
        }, c.req.raw),
      );
    }
    app.all("*", async (c) => {
      const proxied = await proxy(c.req.raw);
      if (proxied) {
        return proxied;
      }
      return c.body(null, 404);
    });
    const traced = traceRpc(tracer, async (request) => {
      const response = await app.fetch(request, env);
      return response.status === 404 ? null : response;
    });
    cached = { env, app, traced };
    return cached;
  };

  return {
    async fetch(request: Request, env: WebBffEnv & Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      if (isBffPath(url.pathname, registerPath, prefixes)) {
        const { traced } = await buildApp(env);
        const proxied = await traced(request, ctx);
        if (proxied) {
          return proxied;
        }
      }
      return env.ASSETS.fetch(request);
    },
  };
};
