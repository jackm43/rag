import {
  extractBotMentionPrompt,
  handleGatewayMessageCreate,
} from "@rag/discord/domain/mention";
import type { Env } from "@rag/discord/contracts";
import {
  DiscordGateway,
  ensureGatewayConnected,
  getGatewayHealth,
  startGateway,
  stopGateway,
} from "./gateway";
import { createGatewayRouter } from "./router";

export { DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

// The gateway's only HTTP surface is the operator control routes
// (start/stop/health), authenticated by the GATEWAY_CONTROL_TOKEN bearer the
// router wires from the route's security scheme; holding that token IS the
// authorization. There is no public discovery surface. Handlers are keyed by
// operationId.
const router = createGatewayRouter({
  startGateway: async (_request, env) => Response.json(await startGateway(env)),
  stopGateway: async (_request, env) => Response.json(await stopGateway(env)),
  gatewayHealth: async (_request, env) => Response.json(await getGatewayHealth(env)),
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.handle(request, env, ctx);
  },
  // Cron trigger: the platform wakes the gateway on a schedule so the websocket
  // self-establishes after any deploy and self-heals, with no manual
  // /gateway/start. ensureConnected() is a no-op if the operator stopped it.
  // (Discord interactions now arrive at the webhooks worker, not here, so the
  // former opportunistic HTTP wake-up is gone; the cron plus the DiscordGateway
  // DO's own watchdog alarm keep the socket up.)
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ensureGatewayConnected(env));
  },
};
