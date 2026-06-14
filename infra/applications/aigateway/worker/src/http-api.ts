import {
  createPlatformHttpApp,
  PlatformServiceError,
  tracerFromEnv,
  type PlatformHandlerContext,
} from "@platy/sdk";

import {
  complete,
  connectorLoader,
  listModels,
  streamComplete,
  HttpServiceError,
  type CompletionInput,
} from "./http-services";
import type { Env } from "./types";

export const aiGatewayHttpApp = createPlatformHttpApp<Env>({
  application: "aigateway",
  openApi: {
    title: "AI Gateway API",
    version: "v1",
    description: "HTTP API for model catalog and chat completions.",
  },
  mapError: (error) => {
    if (error instanceof PlatformServiceError) {
      return error;
    }
    if (error instanceof HttpServiceError) {
      return new PlatformServiceError(error.status, error.message);
    }
    return new PlatformServiceError(500, error instanceof Error ? error.message : String(error));
  },
  handlers: {
    complete: async (ctx: PlatformHandlerContext<Env>) => {
      const connectors = connectorLoader(ctx.env, tracerFromEnv(ctx.env, "aigateway"));
      return complete(
        ctx.env,
        ctx.identity,
        connectors,
        ctx.body as CompletionInput,
        ctx.traceparent,
      );
    },
    streamComplete: (ctx: PlatformHandlerContext<Env>) => {
      const connectors = connectorLoader(ctx.env, tracerFromEnv(ctx.env, "aigateway"));
      return streamComplete(
        ctx.env,
        ctx.identity,
        connectors,
        ctx.body as CompletionInput,
        ctx.traceparent,
      );
    },
    listModels: async (ctx) =>
      listModels(
        ctx.env,
        ctx.identity,
        typeof ctx.query.filter === "string" ? ctx.query.filter : "",
        typeof ctx.query.limit === "string" ? Number(ctx.query.limit) : 0,
      ),
  },
});

export const handleAiGatewayHttpApi = aiGatewayHttpApp.handle;
