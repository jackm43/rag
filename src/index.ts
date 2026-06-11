import { getOidcConfig } from "./access";
import { handleAdminRequest } from "./admin";
import { handleDeferredRagCommand } from "./commands/rag";
import { handleRagboardCommand } from "./commands/ragboard";
import { DiscordGateway, forwardToGateway } from "./gateway";
import { jsonResponse, secretsMatch, verifyDiscordRequest } from "./http";
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

    // Public OIDC client metadata so the CLI only needs the worker URL. The
    // client id of a PKCE public client is not a secret.
    if (url.pathname === "/oauth/config" && request.method === "GET") {
      const oidc = getOidcConfig(env);
      if (!oidc) {
        return jsonResponse({ error: "oidc is not configured" }, 503);
      }
      return jsonResponse({
        issuer: oidc.issuer,
        client_id: oidc.clientId,
        authorization_endpoint: oidc.authorizationEndpoint,
        token_endpoint: oidc.tokenEndpoint,
      });
    }

    if (url.pathname.startsWith("/admin")) {
      return handleAdminRequest(request, env);
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
