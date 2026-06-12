import {
  createRpcHandler,
  gatewayTraceExporter,
  serviceCredentialFromEnv,
  traceRpc,
  tracerFromEnv,
} from "../../../../sdk/ts/src";
import { handleDeferredRagCommand } from "./commands/rag";
import { handleRagboardCommand } from "./commands/ragboard";
import { DiscordGateway } from "./gateway";
import { rejectDisallowedGuild } from "./guild";
import { jsonResponse, verifyDiscordRequest } from "./http";
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

type TracedRpc = (request: Request, ctx?: ExecutionContext) => Promise<Response | null>;

let cachedRpc: { env: Env; gatewayUrl: string; rpc: TracedRpc } | null = null;

const rpcHandler = (env: Env): TracedRpc => {
  const gatewayUrl = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
  if (cachedRpc?.env !== env || cachedRpc.gatewayUrl !== gatewayUrl) {
    const credential = serviceCredentialFromEnv(env);
    const exporter =
      credential && env.AUTH_GATEWAY
        ? gatewayTraceExporter({
            gatewayUrl,
            credential,
            fetch: (input: RequestInfo | URL, init?: RequestInit) => env.AUTH_GATEWAY!.fetch(input, init),
          })
        : undefined;
    cachedRpc = {
      env,
      gatewayUrl,
      rpc: traceRpc(
        tracerFromEnv(env, "ragbot", { exporter }),
        createRpcHandler((router) => registerRagbotServices(router, env)),
      ),
    };
  }
  return cachedRpc.rpc;
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

  if (rejectDisallowedGuild(env, interaction.guild_id)) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "This bot is not enabled for this server." },
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
      const rpcResponse = await rpcHandler(env)(request, ctx);
      if (rpcResponse) {
        return rpcResponse;
      }
      return jsonResponse({ error: "not found" }, 404);
    }

    if (url.pathname.startsWith("/gateway/")) {
      return new Response("Not found", { status: 404 });
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
