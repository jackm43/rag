import {
  createPlatformHttpApp,
  PlatformServiceError,
  type PlatformHandlerContext,
} from "@platy/sdk";

import { buildDiscovery, gatewayAuthenticator } from "./services";
import {
  deleteApplicationRecord,
  exchangeProviderToken,
  getApplicationRecord,
  getProviderConfigRecord,
  getTraceDetail,
  HttpServiceError,
  introspectCaller,
  listApplicationRecords,
  listClientIdentityRecords,
  listTraceSummaries,
  registerApplication,
  registerClientIdentity,
  registerServiceClient,
  streamTraceEvents,
  upsertProviderConfigRecord,
} from "./http-services";
import type { Env } from "./types";

const queryValue = (
  query: PlatformHandlerContext<Env>["query"],
  key: string,
  fallback: string,
): string => {
  const value = query[key];
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }
  return value ?? fallback;
};

const pathParam = (ctx: PlatformHandlerContext<Env>, key: string): string => {
  const value = ctx.params[key];
  if (!value) {
    throw new PlatformServiceError(400, `path parameter ${key} is required`);
  }
  return value;
};

export const gatewayHttpApp = createPlatformHttpApp<Env>({
  application: "idp",
  authenticate: (env) => gatewayAuthenticator(env),
  openApi: {
    title: "Platy Gateway API",
    version: "v1",
    description: "Gateway HTTP APIs for discovery, application registration, identity, traces, and policy.",
  },
  mapError: (error) =>
    error instanceof HttpServiceError ? new PlatformServiceError(error.status, error.message) : null,
  handlers: {
    discover: async (ctx) => buildDiscovery(ctx.env),
    introspect: async (ctx) => introspectCaller(ctx.env, ctx.identity),
    exchangeProviderToken: async (ctx) =>
      exchangeProviderToken(
        ctx.env,
        ctx.request.headers,
        String(ctx.body.application ?? ""),
        typeof ctx.body.subjectToken === "string" ? ctx.body.subjectToken : undefined,
      ),
    getProviderConfig: async (ctx) => getProviderConfigRecord(ctx.env),
    upsertProviderConfig: async (ctx) =>
      upsertProviderConfigRecord(ctx.env, ctx.identity, String(ctx.body.configJson ?? "")),
    registerClientIdentity: async (ctx) =>
      registerClientIdentity(ctx.env, ctx.identity, ctx.body as Parameters<typeof registerClientIdentity>[2]),
    listClientIdentities: async (ctx) =>
      listClientIdentityRecords(ctx.env, ctx.identity, queryValue(ctx.query, "application", "")),
    listApplications: async (ctx) => listApplicationRecords(ctx.env),
    registerApplication: async (ctx) =>
      registerApplication(ctx.env, ctx.identity, ctx.body as Parameters<typeof registerApplication>[2]),
    getApplication: async (ctx) => getApplicationRecord(ctx.env, pathParam(ctx, "applicationId")),
    deleteApplication: async (ctx) =>
      deleteApplicationRecord(ctx.env, ctx.identity, pathParam(ctx, "applicationId")),
    registerClient: async (ctx) =>
      registerServiceClient(ctx.env, ctx.identity, pathParam(ctx, "applicationId")),
    listTraces: async (ctx) =>
      listTraceSummaries(ctx.env, Number(queryValue(ctx.query, "limit", "25"))),
    getTrace: async (ctx) => getTraceDetail(ctx.env, pathParam(ctx, "traceId")),
    streamTraces: (ctx) => streamTraceEvents(ctx.env, ctx.request.signal ?? undefined),
  },
});

export const handleGatewayHttpApi = gatewayHttpApp.handle;
