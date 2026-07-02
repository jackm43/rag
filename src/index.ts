import { handleAskCommand } from "./commands/ask";
import { handleBictureCommand } from "./commands/bicture";
import { processAiQueueMessage } from "./consumer";
import { handleDeferredRagCommand } from "./commands/rag";
import { handleRagboardCommand } from "./commands/ragboard";
import { handleRagjamCommand } from "./commands/ragjam";
import { handleRagspendCommand, handleRagspendboardCommand } from "./commands/ragspend";
import { handleRaghammerCommand } from "./commands/raghammer";
import { handleRagunbanCommand } from "./commands/ragunban";
import { handleUndoragCommand } from "./commands/undorag";
import { DiscordGateway, getGatewayHealth, startGateway } from "./gateway";
import { bearerTokenMatches, jsonResponse, verifyDiscordRequest } from "./http";
import { errorMessage, logger } from "./logger";
import { extractBotMentionPrompt, handleGatewayMessageCreate } from "./mention";
import {
  APPLICATION_COMMAND,
  CHANNEL_MESSAGE_WITH_SOURCE,
  PING,
  type DiscordInteraction,
  type Env,
} from "./types";

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

type CommandHandler = (
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

const commandHandlers: Record<string, CommandHandler> = {
  rag: handleDeferredRagCommand,
  ragboard: (_interaction, env) => handleRagboardCommand(env),
  ragspend: (interaction, env) => handleRagspendCommand(interaction, env),
  ragspendboard: (_interaction, env) => handleRagspendboardCommand(env),
  raghammer: (interaction, env) => handleRaghammerCommand(interaction, env),
  ragunban: (interaction, env) => handleRagunbanCommand(interaction, env),
  undorag: (interaction, env) => handleUndoragCommand(interaction, env),
  ask: handleAskCommand,
  bicture: handleBictureCommand,
  ragjam: (interaction, env) => handleRagjamCommand(interaction, env),
};

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

const handleInteractionRequest = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
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
    const handler = commandName && Object.hasOwn(commandHandlers, commandName)
      ? commandHandlers[commandName]
      : undefined;
    if (handler) {
      return handler(interaction, env, ctx);
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
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processAiQueueMessage(message, env);
    }
  },
};
