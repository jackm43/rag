import { createPlatformRpcWorker } from "@platy/sdk";
import { registerAiGatewayServices } from "./services";
import type { Env } from "./types";

export default createPlatformRpcWorker<Env>({
  serviceName: "aigateway",
  register: (router, env, tracer) => registerAiGatewayServices(router, env, tracer),
  cors: {
    originsEnv: "AIG_ALLOWED_ORIGINS",
  },
});
