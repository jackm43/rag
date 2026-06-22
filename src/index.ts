import { handleDeferredRagCommand } from "./commands/rag";
import { handleRagboardCommand } from "./commands/ragboard";
import { DiscordGateway, getGatewayHealth, startGateway } from "./gateway";
import { bearerTokenMatches, jsonResponse, verifyDiscordRequest } from "./http";
import { errorMessage, logger } from "./logger";
import { extractBotMentionPrompt, handleGatewayMessageCreate, processAiQueueMessage } from "./mention";
import { getGatewayControlToken, isDiscordGuildAllowed } from "./security";
import {
  APPLICATION_COMMAND,
  CHANNEL_MESSAGE_WITH_SOURCE,
  PING,
  type AiJob,
  type Env,
} from "./types";
import { AssistantWorkflow } from "./workflow";

export { AssistantWorkflow, DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

const hasRequiredHeaders = (request: Request, headers: string[]) =>
  headers.every((header) => request.headers.has(header));

const handleGatewayControlRequest = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  if (!hasRequiredHeaders(request, ["authorization"])) {
    return new Response("Unauthorized", { status: 401 });
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!bearerTokenMatches(authorization, getGatewayControlToken(env))) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (url.pathname === "/gateway/health" && request.method === "GET") {
    return Response.json(await getGatewayHealth(env));
  }

  if (url.pathname === "/gateway/start" && request.method === "POST") {
    return Response.json(await startGateway(env));
  }

  return new Response("Not found", { status: 404 });
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

  if (!isDiscordGuildAllowed(env, interaction.guild_id)) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "This bot is not enabled in this server.",
        allowed_mentions: { parse: [] },
      },
    });
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

    if (url.pathname.startsWith("/gateway/")) {
      return handleGatewayControlRequest(request, env);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("ok");
    }

    if (url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    return handleInteractionRequest(request, env, ctx);
  },
  async queue(batch: MessageBatch<AiJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processAiQueueMessage(message, env);
    }
  },
};
