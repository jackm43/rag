import { handleAskCommand } from "./commands/ask";
import { handleDeferredRagCommand } from "./commands/rag";
import { handleRagboardCommand } from "./commands/ragboard";
import { DiscordGateway, getGatewayHealth, startGateway } from "./gateway";
import { bearerTokenMatches, jsonResponse, verifyDiscordRequest } from "./http";
import { errorMessage, logger } from "./logger";
import { extractBotMentionPrompt, handleGatewayMessageCreate, processAiQueueMessage } from "./mention";
import {
  APPLICATION_COMMAND,
  CHANNEL_MESSAGE_WITH_SOURCE,
  PING,
  type AiJob,
  type Env,
} from "./types";

export { DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

const DISCORD_INTERACTIONS_PATH = "/discord";
const GATEWAY_START_PATH = "/gateway/start";
const GATEWAY_HEALTH_PATH = "/gateway/health";

const hasRequiredHeaders = (request: Request, headers: string[]) =>
  headers.every((header) => request.headers.has(header));

const methodNotAllowed = (allowedMethod: string) =>
  new Response("Method not allowed", {
    status: 405,
    headers: { Allow: allowedMethod },
  });

const unauthorized = () => new Response("Unauthorized", { status: 401 });

const notFound = () => new Response("Not found", { status: 404 });

const isAuthorizedGatewayControlRequest = (request: Request, env: Env) => {
  const authorization = request.headers.get("authorization");
  return authorization !== null && bearerTokenMatches(authorization, env.DISCORD_BOT_TOKEN);
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

const handleInteractionRequest = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  if (!hasRequiredHeaders(request, ["x-signature-ed25519", "x-signature-timestamp"])) {
    return new Response("Bad request signature", { status: 401 });
  }

  const interaction = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!interaction) {
    return new Response("Bad request signature", { status: 401 });
  }

  if (interaction.type === PING) {
    return jsonResponse({ type: PING });
  }

  if (interaction.type !== APPLICATION_COMMAND) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unsupported interaction." },
    });
  }

  try {
    const commandName = interaction.data?.name;
    if (commandName === "rag") {
      return handleDeferredRagCommand(interaction, env, ctx);
    }

    if (commandName === "ragboard") {
      return handleRagboardCommand(env);
    }

    if (commandName === "ask") {
      return handleAskCommand(interaction, env, ctx);
    }

    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unknown command." },
    });
  } catch (error) {
    logger.error("interaction_failed", { error: errorMessage(error) });
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Command failed. Try again." },
    });
  }
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

    return handleInteractionRequest(request, env, ctx);
  },
  async queue(batch: MessageBatch<AiJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processAiQueueMessage(message, env);
    }
  },
};
