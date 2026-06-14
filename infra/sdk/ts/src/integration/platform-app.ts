import { platformAuthenticator, type PlatformAuthEnv } from "../auth/platform";
import type { Authenticator } from "../auth/authenticators";
import type { Identity } from "../identity";
import { catalogApplication, catalogMethod, catalogRoutePrefix, registerCatalogApplication } from "../catalog/registry";
import type { CatalogApplication } from "../catalog/types";
import { apiError, apiResponse } from "../http/envelope";
import { buildOpenApiDocument } from "../http/openapi";
import { createPlatformHonoApp } from "../http/app";
import { ndjsonResponse } from "../http/ndjson";
import { requirePlatformAuthorization } from "../http/auth";
import { requireIdentityContext, type PlatformHonoVariables } from "../http/context";
import type { RouteContract } from "../http/types";
import { HTTPException } from "hono/http-exception";
import { transportModeFromEnv, serviceBindingFetch, verifyInboundWorkerTransport } from "../transport";

export class PlatformServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlatformServiceError";
  }
}

export type PlatformHandlerContext<Env> = {
  env: Env;
  identity: Identity;
  body: Record<string, unknown>;
  query: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  request: Request;
  requestId: string;
  traceparent: string | null;
};

export type PlatformHandler<Env> =
  | ((ctx: PlatformHandlerContext<Env>) => Promise<unknown>)
  | ((ctx: PlatformHandlerContext<Env>) => AsyncGenerator<unknown>);

export type PlatformHttpAppConfig<Env extends object> = {
  application: string;
  catalog?: CatalogApplication;
  openApi: {
    title: string;
    description: string;
    version: string;
  };
  handlers: Record<string, PlatformHandler<Env>>;
  authenticate?: (env: Env, audience: string) => Authenticator;
  mapError?: (error: unknown) => PlatformServiceError | null;
};

type AppEnv<Env extends object> = { Bindings: Env; Variables: PlatformHonoVariables };

const statusCode = (value: number): 400 | 401 | 403 | 404 | 412 | 429 | 500 =>
  ([400, 401, 403, 404, 412, 429, 500] as const).includes(value as 400 | 401 | 403 | 404 | 412 | 429 | 500)
    ? value as 400 | 401 | 403 | 404 | 412 | 429 | 500
    : 500;

const honoPath = (path: string): string => path.replace(/\{([^}]+)\}/g, ":$1");

export const createPlatformHttpApp = <Env extends object>(config: PlatformHttpAppConfig<Env>) => {
  if (config.catalog) {
    registerCatalogApplication(config.catalog);
  }
  const appCatalog = catalogApplication(config.application);
  const routes = appCatalog.resources.flatMap((resource) => resource.methods.map((method) => method.route));
  const openapiRoute: RouteContract = {
    namespace: "platform",
    apiName: appCatalog.apiName,
    version: "v1",
    audience: appCatalog.audience,
    method: "GET",
    path: "/.well-known/openapi.json",
    operationId: `get${appCatalog.apiName[0].toUpperCase()}${appCatalog.apiName.slice(1)}OpenApi`,
    summary: `Get the ${config.application} OpenAPI document`,
    auth: "none",
    identityContext: "none",
    tags: [appCatalog.apiName],
  };
  const routeList = [openapiRoute, ...routes];
  const app = createPlatformHonoApp<Env>({ application: config.application });

  app.use("*", async (c, next) => {
    const env = c.env as PlatformAuthEnv;
    const ok = await verifyInboundWorkerTransport(
      {
        application: config.application,
        mode: transportModeFromEnv(env),
        gatewayUrl: env.AUTH_GATEWAY_URL,
        gatewayFetch: env.AUTH_GATEWAY
          ? serviceBindingFetch(env.AUTH_GATEWAY, "AUTH_GATEWAY")
          : undefined,
      },
      c.req.raw,
    );
    if (!ok) {
      throw new HTTPException(403, { message: "service transport verification failed" });
    }
    await next();
  });

  const auth = (contract: RouteContract) =>
    async (c: import("hono").Context<AppEnv<Env>>, next: import("hono").Next) => {
      const authenticate = config.authenticate
        ?? ((env, audience) => platformAuthenticator(env as PlatformAuthEnv, audience));
      await requireIdentityContext<Env>(contract)(c, async () => {
        await requirePlatformAuthorization<Env>(
          contract,
          authenticate(c.env, contract.audience),
        )(c, next);
      });
    };

  const identity = (c: import("hono").Context<AppEnv<Env>>): Identity => {
    const value = c.get("identity");
    if (!value) {
      throw new HTTPException(401, { message: "identity is required" });
    }
    return value;
  };

  const mapError = (error: unknown): PlatformServiceError => {
    const mapped = config.mapError?.(error);
    if (mapped) {
      return mapped;
    }
    if (error instanceof PlatformServiceError) {
      return error;
    }
    if (error instanceof HTTPException) {
      return new PlatformServiceError(error.status, error.message);
    }
    return new PlatformServiceError(500, error instanceof Error ? error.message : String(error));
  };

  app.onError((error, c) => {
    const mapped = mapError(error);
    return c.json(apiError({
      status: mapped.status,
      code: mapped.status === 401 ? "unauthorized"
        : mapped.status === 403 ? "forbidden"
          : mapped.status === 412 ? "provider_request_failed"
            : mapped.status >= 500 ? "internal_error" : "bad_request",
      title: mapped.status >= 500 ? "Internal error" : "Request failed",
      detail: mapped.message,
      requestId: c.get("requestId"),
    }), statusCode(mapped.status));
  });

  app.get(openapiRoute.path, (c) =>
    c.json(buildOpenApiDocument(
      {
        title: config.openApi.title,
        version: config.openApi.version,
        description: config.openApi.description,
      },
      routeList,
    )),
  );

  for (const resource of appCatalog.resources) {
    for (const method of resource.methods) {
      const handler = config.handlers[method.operationId];
      if (!handler) {
        throw new Error(`missing platform handler for ${config.application}.${method.operationId}`);
      }
      const middleware = auth(method.route);
      const routeHandler = async (c: import("hono").Context<AppEnv<Env>>) => {
        const ctx: PlatformHandlerContext<Env> = {
          env: c.env,
          identity: identity(c),
          body: method.http.method === "GET" || method.http.method === "DELETE"
            ? {}
            : ((await c.req.json().catch(() => ({}))) as { data?: Record<string, unknown> }).data ?? {},
          query: c.req.queries(),
          params: c.req.param(),
          request: c.req.raw,
          requestId: c.get("requestId"),
          traceparent: c.req.header("traceparent") ?? null,
        };
        const result = handler(ctx);
        if (result && typeof result === "object" && Symbol.asyncIterator in result) {
          return ndjsonResponse(result as AsyncGenerator<unknown>, {
            "x-request-id": c.get("requestId"),
          });
        }
        return c.json(apiResponse(await (result as Promise<unknown>)));
      };
      switch (method.http.method) {
        case "GET":
          app.get(honoPath(method.route.path), middleware, routeHandler);
          break;
        case "POST":
          app.post(honoPath(method.route.path), middleware, routeHandler);
          break;
        case "PUT":
          app.put(honoPath(method.route.path), middleware, routeHandler);
          break;
        case "PATCH":
          app.patch(honoPath(method.route.path), middleware, routeHandler);
          break;
        case "DELETE":
          app.delete(honoPath(method.route.path), middleware, routeHandler);
          break;
        default:
          throw new Error(`unsupported method ${method.http.method}`);
      }
    }
  }

  const prefixes = [
    "/.well-known/openapi.json",
    ...new Set(routeList.map((route) => {
      const match = /^(\/platform\/[^/]+\/v\d+\/)/.exec(route.path);
      return match?.[1] ?? route.path;
    })),
  ];

  return {
    app,
    fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
    handle: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> => {
      const url = new URL(request.url);
      if (!prefixes.some((prefix) => url.pathname.startsWith(prefix))) {
        return Promise.resolve(null);
      }
      return Promise.resolve(app.fetch(request, env, ctx));
    },
    catalogMethod,
  };
};
