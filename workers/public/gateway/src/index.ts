import { ensureRegistered } from "../../../../packages/auth";
import { authorize } from "../../../../packages/authz/authorize";
import type { DiscordInteractionPrincipal } from "../../../../packages/boundaries/inbound/discord-interaction";
import { routeInteraction } from "../../../../packages/domain/commands/router";
import {
  extractBotMentionPrompt,
  handleGatewayMessageCreate,
} from "../../../../packages/domain/mention";
import type { Env } from "../../../../packages/contracts/types";
import { DevProxy } from "./devproxy-entrypoint";
import {
  DiscordGateway,
  ensureGatewayConnected,
  getGatewayHealth,
  startGateway,
  stopGateway,
} from "./gateway";
import { GATEWAY_MANIFEST } from "./manifest";
import { createGatewayRouter } from "./router";

export { DevProxy, DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

// The bearer-token guard (wired by the router from the spec's security
// scheme) authenticates the operator; Cedar decides what the operator
// machine principal may do with the gateway control plane.
const operatorForbidden = (action: string): Response | null =>
  authorize({
    principal: { type: "Machine", id: "operator" },
    action,
    resource: { type: "Gateway", id: "control" },
  }).allowed
    ? null
    : new Response("Forbidden", { status: 403 });

// Handlers keyed by openapi.yaml operationId; the router runs each
// operation's ingress guard first and passes its grant through.
const router = createGatewayRouter({
  discordInteraction: (_request, env, ctx, grant) =>
    routeInteraction((grant as DiscordInteractionPrincipal).interaction, env, ctx),
  startGateway: async (_request, env) =>
    operatorForbidden("gateway.start") ?? Response.json(await startGateway(env)),
  stopGateway: async (_request, env) =>
    operatorForbidden("gateway.stop") ?? Response.json(await stopGateway(env)),
  gatewayHealth: async (_request, env) =>
    operatorForbidden("gateway.health") ?? Response.json(await getGatewayHealth(env)),
});

const DISCORD_INTERACTIONS_PATH = "/discord";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureRegistered(env, GATEWAY_MANIFEST));
    // Opportunistic wake-up (B): an incoming interaction webhook arrives over
    // HTTP independently of the gateway websocket, so use it to ensure the
    // socket is up. This brings the connection back the instant a command is
    // used after a deploy, without waiting for the cron tick.
    if (request.method === "POST" && new URL(request.url).pathname === DISCORD_INTERACTIONS_PATH) {
      ctx.waitUntil(ensureGatewayConnected(env));
    }
    return router.handle(request, env, ctx);
  },
  // Cron trigger (A): the platform wakes the gateway on a schedule so the
  // websocket self-establishes after any deploy and self-heals, with no manual
  // /gateway/start. ensureConnected() is a no-op if the operator stopped it.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ensureGatewayConnected(env));
  },
};
