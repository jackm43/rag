import { ensureRegistered } from "../../../../packages/auth";
import { authorize } from "../../../../packages/authz/authorize";
import type { DiscordInteractionPrincipal } from "../../../../packages/boundaries/inbound/discord-interaction";
import { routeInteraction } from "../../../../packages/domain/commands/router";
import {
  extractBotMentionPrompt,
  handleGatewayMessageCreate,
} from "../../../../packages/domain/mention";
import type { Env } from "../../../../packages/contracts/types";
import { DiscordGateway, getGatewayHealth, startGateway, stopGateway } from "./gateway";
import { GATEWAY_MANIFEST } from "./manifest";
import { ServiceRegistry } from "./registry";
import { createGatewayRouter } from "./router";

export { DiscordGateway, ServiceRegistry, extractBotMentionPrompt, handleGatewayMessageCreate };

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureRegistered(env, GATEWAY_MANIFEST));
    return router.handle(request, env, ctx);
  },
};
