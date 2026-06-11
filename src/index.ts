import { createRpcHandler, type RpcHandler } from "../infra/sdk/ts/src";
import { handleDeferredRagCommand } from "./commands/rag";
import { handleRagboardCommand } from "./commands/ragboard";
import { DiscordGateway, forwardToGateway } from "./gateway";
import { jsonResponse, secretsMatch, verifyDiscordRequest } from "./http";
import { errorMessage, logger } from "./logger";
import { extractBotMentionPrompt, handleGatewayMessageCreate, processAiQueueMessage } from "./mention";
import { registerRagbotServices } from "./services";
import {
  APPLICATION_COMMAND,
  CHANNEL_MESSAGE_WITH_SOURCE,
  PING,
  type AiJob,
  type Env,
} from "./types";

export { DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

let cachedRpc: { env: Env; rpc: RpcHandler } | null = null;

const rpcHandler = (env: Env): RpcHandler => {
  if (cachedRpc?.env !== env) {
    cachedRpc = { env, rpc: createRpcHandler((router) => registerRagbotServices(router, env)) };
  }
  return cachedRpc.rpc;
};

const handleGatewayControlRequest = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === "/gateway/health" && request.method === "GET") {
    return forwardToGateway(request, env, "/gateway/health");
  }

  if (url.pathname === "/gateway/start" && request.method === "POST") {
    const authorization = request.headers.get("authorization") ?? "";
    if (!(await secretsMatch(authorization, `Bearer ${env.DISCORD_BOT_TOKEN}`))) {
      return new Response("Unauthorized", { status: 401 });
    }
    return forwardToGateway(request, env, "/gateway/start");
  }

  return new Response("Not found", { status: 404 });
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

    if (url.pathname.startsWith("/ragbot.v1.")) {
      const rpcResponse = await rpcHandler(env)(request);
      if (rpcResponse) {
        return rpcResponse;
      }
      return jsonResponse({ error: "not found" }, 404);
    }

    if (url.pathname.startsWith("/gateway/")) {
      return handleGatewayControlRequest(request, env);
    }

    if (request.method === "GET") {
      return new Response("ok");
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
