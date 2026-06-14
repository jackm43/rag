import {
  createPlatformHttpApp,
  PlatformServiceError,
  type PlatformHandlerContext,
} from "@platy/sdk";

import { HttpServiceError, queryDiscovery, syncDiscovery } from "./http-services";
import type { Env } from "./types";

export const discoveryHttpApp = createPlatformHttpApp<Env>({
  application: "discovery",
  openApi: {
    title: "Discovery API",
    version: "v1",
    description: "HTTP API for registry read-model GraphQL queries and synchronisation.",
  },
  mapError: (error) =>
    error instanceof HttpServiceError ? new PlatformServiceError(error.status, error.message) : null,
  handlers: {
    query: async (ctx) =>
      queryDiscovery(ctx.env, ctx.body as Parameters<typeof queryDiscovery>[1]),
    sync: async (ctx) => syncDiscovery(ctx.env, ctx.identity),
  },
});

export const handleDiscoveryHttpApi = discoveryHttpApp.handle;
