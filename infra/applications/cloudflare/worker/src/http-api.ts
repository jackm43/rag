import {
  createPlatformHttpApp,
  PlatformServiceError,
  type PlatformHandlerContext,
} from "@platy/sdk";

import {
  deleteCloudflareDevice,
  deployCloudflareWorker,
  getCloudflareDevice,
  listCloudflareDevices,
  listCloudflareWorkers,
  revokeCloudflareDevice,
} from "./http-services";
import { HttpServiceError } from "./errors";
import type { Env } from "./types";

const queryList = (request: Request, name: string): string[] | undefined => {
  const url = new URL(request.url);
  const values = url.searchParams.getAll(name);
  return values.length > 0 ? values : undefined;
};

export const cloudflareHttpApp = createPlatformHttpApp<Env>({
  application: "cloudflare",
  openApi: {
    title: "Cloudflare Connector API",
    version: "v1",
    description: "HTTP provider connector for Cloudflare devices and Workers.",
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
    listDevices: async (ctx: PlatformHandlerContext<Env>) =>
      listCloudflareDevices(ctx.env, ctx.identity, {
        ids: queryList(ctx.request, "id"),
        activeRegistrations: typeof ctx.query.activeRegistrations === "string" ? ctx.query.activeRegistrations : undefined,
        cursor: typeof ctx.query.cursor === "string" ? ctx.query.cursor : undefined,
        include: typeof ctx.query.include === "string" ? ctx.query.include : undefined,
        lastSeenUserEmail: typeof ctx.query.lastSeenUserEmail === "string" ? ctx.query.lastSeenUserEmail : undefined,
        perPage: typeof ctx.query.perPage === "string" ? Number(ctx.query.perPage) : undefined,
        search: typeof ctx.query.search === "string" ? ctx.query.search : undefined,
        seenAfter: typeof ctx.query.seenAfter === "string" ? ctx.query.seenAfter : undefined,
        seenBefore: typeof ctx.query.seenBefore === "string" ? ctx.query.seenBefore : undefined,
        sortBy: typeof ctx.query.sortBy === "string" ? ctx.query.sortBy : undefined,
        sortOrder: typeof ctx.query.sortOrder === "string" ? ctx.query.sortOrder : undefined,
      }),
    getDevice: async (ctx) =>
      getCloudflareDevice(
        ctx.env,
        ctx.identity,
        ctx.params.deviceId,
        typeof ctx.query.include === "string" ? ctx.query.include : undefined,
      ),
    deleteDevice: async (ctx) =>
      deleteCloudflareDevice(ctx.env, ctx.identity, ctx.params.deviceId),
    revokeDevice: async (ctx) =>
      revokeCloudflareDevice(ctx.env, ctx.identity, ctx.params.deviceId),
    deployWorker: async (ctx) =>
      deployCloudflareWorker(ctx.env, ctx.identity, ctx.body as never),
    listWorkers: async (ctx) =>
      listCloudflareWorkers(ctx.env, ctx.identity),
  },
});

export const handleCloudflareHttpApi = cloudflareHttpApp.handle;
