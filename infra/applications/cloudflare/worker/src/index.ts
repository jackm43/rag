import { createPlatformRpcWorker } from "@platy/sdk";
import { registerCloudflareServices } from "./services";
import type { Env } from "./types";

export default createPlatformRpcWorker<Env>({
  serviceName: "cloudflare",
  register: (router, env) => registerCloudflareServices(router, env),
});
