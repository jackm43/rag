import { routeInteraction } from "../../../../packages/domain/commands/router";
import { bearerTokenMatches, verifyDiscordRequest } from "../../../../packages/domain/http";
import {
  extractBotMentionPrompt,
  handleGatewayMessageCreate,
} from "../../../../packages/domain/mention";
import type { Env } from "../../../../packages/contracts/types";
import { DiscordGateway, getGatewayHealth, startGateway } from "./gateway";

export { DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

const DISCORD_INTERACTIONS_PATH = "/discord";
const GATEWAY_START_PATH = "/gateway/start";
const GATEWAY_HEALTH_PATH = "/gateway/health";

const methodNotAllowed = (allowedMethod: string) =>
  new Response("Method not allowed", {
    status: 405,
    headers: { Allow: allowedMethod },
  });

const unauthorized = () => new Response("Unauthorized", { status: 401 });

const notFound = () => new Response("Not found", { status: 404 });

const isAuthorizedGatewayControlRequest = (request: Request, env: Env) => {
  const controlToken = env.GATEWAY_CONTROL_TOKEN;
  if (!controlToken) {
    return false;
  }

  const authorization = request.headers.get("authorization");
  return authorization !== null && bearerTokenMatches(authorization, controlToken);
};

const handleGatewayStartRequest = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }

  if (!isAuthorizedGatewayControlRequest(request, env)) {
    return unauthorized();
  }

  return Response.json(await startGateway(env));
};

const handleGatewayHealthRequest = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }

  if (!isAuthorizedGatewayControlRequest(request, env)) {
    return unauthorized();
  }

  return Response.json(await getGatewayHealth(env));
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === GATEWAY_START_PATH) {
      return handleGatewayStartRequest(request, env);
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

    const interaction = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!interaction) {
      return new Response("Bad request signature", { status: 401 });
    }

    return routeInteraction(interaction, env, ctx);
  },
};
