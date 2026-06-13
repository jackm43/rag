import { createPlatformRpcWorker } from "@platy/sdk";
import { registerDeployServices } from "./services";
import type { Env } from "./types";

export default createPlatformRpcWorker<Env>({
  serviceName: "deploy",
  register: (router, env) => registerDeployServices(router, env),
});
