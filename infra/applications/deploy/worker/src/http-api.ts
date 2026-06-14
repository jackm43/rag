import {
  passThroughPlatformClient,
  createPlatformHttpApp,
  type PlatformHandlerContext,
} from "@platy/sdk";

import type { Env } from "./types";

type DeployWorkerRequest = {
  scriptName: string;
  mainModule: string;
  modules: Array<{
    name: string;
    contentType?: string;
    content: string | ArrayBuffer | Blob;
  }>;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  metadata?: Record<string, unknown>;
};

type WorkerServiceClient = {
  listWorkers: (request?: Record<string, never>) => Promise<unknown>;
  deployWorker: (request: DeployWorkerRequest) => Promise<unknown>;
};

const cloudflareClient = (env: Env, identity: PlatformHandlerContext<Env>["identity"]) =>
  passThroughPlatformClient("cloudflare", env, {
    endpoint: env.CLOUDFLARE_ENDPOINT,
    binding: env.CLOUDFLARE,
    bindingName: "CLOUDFLARE",
    scopes: ["cloudflare/WorkerService.DeployWorker", "cloudflare/WorkerService.ListWorkers"],
  }, identity);

const workerService = async (env: Env, identity: PlatformHandlerContext<Env>["identity"]) =>
  (await cloudflareClient(env, identity)).workerServiceClient() as unknown as WorkerServiceClient;

export const deployHttpApp = createPlatformHttpApp<Env>({
  application: "deploy",
  openApi: {
    title: "Deploy API",
    version: "v1",
    description: "HTTP API for platform worker deployment orchestration.",
  },
  handlers: {
    listWorkers: async (ctx) =>
      (await workerService(ctx.env, ctx.identity)).listWorkers({}),
    deployWorker: async (ctx) =>
      (await workerService(ctx.env, ctx.identity)).deployWorker(ctx.body as DeployWorkerRequest),
  },
});

export const handleDeployHttpApi = deployHttpApp.handle;
