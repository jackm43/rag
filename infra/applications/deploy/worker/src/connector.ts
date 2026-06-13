import { Code, ConnectError } from "@connectrpc/connect";

import { workerServiceClient as cloudflareWorkerServiceClient } from "../../../cloudflare/service";
import { serviceConnection, type Identity } from "../../../../sdk/ts/src";
import type { Env } from "./types";

export const CLOUDFLARE_WORKER_SCOPES = [
  "cloudflare/WorkerService.DeployWorker",
  "cloudflare/WorkerService.ListWorkers",
] as const;

export const workerServiceClient = (env: Env, identity: Identity) => {
  const connection = serviceConnection(env, {
    endpoint: env.CLOUDFLARE_ENDPOINT,
    binding: env.CLOUDFLARE,
    scopes: [...CLOUDFLARE_WORKER_SCOPES],
  });
  if (!connection) {
    throw new ConnectError("cloudflare connector is not configured", Code.FailedPrecondition);
  }
  return cloudflareWorkerServiceClient(connection, identity);
};
