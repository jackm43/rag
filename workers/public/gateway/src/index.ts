import { authorize } from "../../../../packages/authz/authorize";
import { discordInteractionGuard } from "../../../../packages/boundaries/inbound/discord-interaction";
import { operatorControlGuard } from "../../../../packages/boundaries/inbound/operator-control";
import { routeInteraction } from "../../../../packages/domain/commands/router";
import {
  extractBotMentionPrompt,
  handleGatewayMessageCreate,
} from "../../../../packages/domain/mention";
import type { Env } from "../../../../packages/contracts/types";
import { DiscordGateway, getGatewayHealth, startGateway, stopGateway } from "./gateway";

export { DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

const DISCORD_INTERACTIONS_PATH = "/discord";
const GATEWAY_START_PATH = "/gateway/start";
const GATEWAY_STOP_PATH = "/gateway/stop";
const GATEWAY_HEALTH_PATH = "/gateway/health";

const methodNotAllowed = (allowedMethod: string) =>
  new Response("Method not allowed", {
    status: 405,
    headers: { Allow: allowedMethod },
  });

const notFound = () => new Response("Not found", { status: 404 });

// The bearer-token guard authenticates the operator; Cedar decides what the
// operator principal may do with the gateway control plane.
const operatorForbidden = (action: string): Response | null =>
  authorize({
    principal: { type: "Operator", id: "control" },
    action,
    resource: { type: "Gateway", id: "control" },
  }).allowed
    ? null
    : new Response("Forbidden", { status: 403 });

const handleGatewayStartRequest = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }

  const operator = await operatorControlGuard.verify(request, env);
  if (!operator.ok) {
    return operator.response;
  }

  return operatorForbidden("gateway.start") ?? Response.json(await startGateway(env));
};

const handleGatewayStopRequest = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }

  const operator = await operatorControlGuard.verify(request, env);
  if (!operator.ok) {
    return operator.response;
  }

  return operatorForbidden("gateway.stop") ?? Response.json(await stopGateway(env));
};

const handleGatewayHealthRequest = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }

  const operator = await operatorControlGuard.verify(request, env);
  if (!operator.ok) {
    return operator.response;
  }

  return operatorForbidden("gateway.health") ?? Response.json(await getGatewayHealth(env));
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === GATEWAY_START_PATH) {
      return handleGatewayStartRequest(request, env);
    }

    if (url.pathname === GATEWAY_STOP_PATH) {
      return handleGatewayStopRequest(request, env);
    }

    if (url.pathname === GATEWAY_HEALTH_PATH) {
      return handleGatewayHealthRequest(request, env);
    }

    if (url.pathname.startsWith("/gateway/")) {
      return notFound();
    }

    if (url.pathname !== DISCORD_INTERACTIONS_PATH) {
      return notFound();
    }

    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }

    const discord = await discordInteractionGuard.verify(request, env);
    if (!discord.ok) {
      return discord.response;
    }

    return routeInteraction(discord.grant.interaction, env, ctx);
  },
};
