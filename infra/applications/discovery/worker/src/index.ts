import { createPlatformRpcWorker, errorMessage, logger } from "../../../../sdk/ts/src";
import { d1Store } from "./data";
import { registerDiscoveryServices } from "./services";
import { selfIdentity, syncRegistry } from "./sync";
import type { Env } from "./types";

const worker = createPlatformRpcWorker<Env>({
  serviceName: "discovery",
  register: (router, env) => registerDiscoveryServices(router, env),
});

export default {
  fetch: worker.fetch,

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const identity = await selfIdentity(env);
          await syncRegistry(env, d1Store(env.DB), identity);
        } catch (error) {
          logger.error("discovery_sync_failed", { error: errorMessage(error) });
        }
      })(),
    );
  },
};
