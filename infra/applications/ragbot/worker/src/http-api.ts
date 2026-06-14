import {
  createPlatformHttpApp,
  PlatformServiceError,
  type PlatformHandlerContext,
} from "@platy/sdk";

import {
  chat,
  getConfig,
  getGatewayHealth,
  HttpServiceError,
  listConfig,
  listInteractions,
  listTotals,
  queryDatabase,
  resetConfig,
  startGateway,
  streamChat,
  updateConfig,
  type ChatRequest,
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

export const ragbotHttpApp = createPlatformHttpApp<Env>({
  application: "ragbot",
  openApi: {
    title: "Ragbot API",
    version: "v1",
    description: "HTTP API for ragbot configuration, chat, interactions, leaderboard, and Discord gateway control.",
  },
  mapError: (error) =>
    error instanceof HttpServiceError ? new PlatformServiceError(error.status, error.message) : null,
  handlers: {
    listConfig: async (ctx) => listConfig(ctx.env),
    getConfig: async (ctx) => getConfig(ctx.env, pathParam(ctx, "key")),
    updateConfig: async (ctx) =>
      updateConfig(ctx.env, ctx.identity, pathParam(ctx, "key"), String(ctx.body.value ?? "")),
    resetConfig: async (ctx) => resetConfig(ctx.env, ctx.identity, pathParam(ctx, "key")),
    listInteractions: async (ctx) =>
      listInteractions(ctx.env, Number(queryValue(ctx.query, "limit", "20"))),
    listTotals: async (ctx) =>
      listTotals(ctx.env, Number(queryValue(ctx.query, "limit", "25"))),
    query: async (ctx) =>
      queryDatabase(
        ctx.env,
        ctx.identity,
        String(ctx.body.sql ?? ""),
        Array.isArray(ctx.body.params) ? ctx.body.params : [],
      ),
    chat: async (ctx) => chat(ctx.env, ctx.identity, ctx.body as unknown as ChatRequest),
    streamChat: (ctx) => streamChat(ctx.env, ctx.identity, ctx.body as unknown as ChatRequest),
    getHealth: async (ctx) => getGatewayHealth(ctx.env),
    startGateway: async (ctx) => startGateway(ctx.env, ctx.identity),
  },
});

export const handleRagbotHttpApi = ragbotHttpApp.handle;
