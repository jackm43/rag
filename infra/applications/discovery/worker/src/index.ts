import { errorMessage, logger } from "@platy/sdk";
import { d1Store } from "./data";
import { handleDiscoveryHttpApi } from "./http-api";
import { selfIdentity, syncRegistry } from "./sync";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return await handleDiscoveryHttpApi(request, env, ctx)
      ?? Response.json({ errors: [{ status: 404, code: "not_found", title: "Not found" }] }, { status: 404 });
  },

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
