import {
  errorMessage,
  logger,
  resolveSecret,
} from "@platy/sdk";
import { handleDeferredRagCommand } from "./commands/rag";
import { handleRagboardCommand } from "./commands/ragboard";
import { DiscordGateway } from "./gateway";
import { rejectDisallowedGuild } from "./guild";
import { jsonResponse, verifyDiscordRequest } from "./http";
import { handleRagbotHttpApi } from "./http-api";
import webBff from "./worker";
import { extractBotMentionPrompt, extractReplyToBotPrompt, handleGatewayMessageCreate, processAiQueueMessage, resolveChannelPrompt } from "./mention";
import {
  APPLICATION_COMMAND,
  CHANNEL_MESSAGE_WITH_SOURCE,
  PING,
  type AiJob,
  type Env,
} from "./types";

export { DiscordGateway, extractBotMentionPrompt, extractReplyToBotPrompt, handleGatewayMessageCreate, resolveChannelPrompt };

const bearerAudience = (request: Request): string | null => {
  const header = request.headers.get("authorization") ?? "";
  const match = /^bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return null;
  }
  const segments = match[1].split(".");
  if (segments.length < 2) {
    return null;
  }
  try {
    const payload = JSON.parse(atob(segments[1].replace(/-/g, "+").replace(/_/g, "/"))) as { aud?: unknown };
    return typeof payload.aud === "string" ? payload.aud : null;
  } catch {
    return null;
  }
};

const shouldUseWebBff = (pathname: string, request: Request): boolean => {
  if (pathname.startsWith("/client/")) {
    return true;
  }
  if (!pathname.startsWith("/platform/")) {
    return false;
  }
  const audience = bearerAudience(request);
  return audience === null || audience === "idp";
};

const handleInteractionRequest = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const interaction = await verifyDiscordRequest(request, await resolveSecret(env.DISCORD_PUBLIC_KEY));
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

    if (shouldUseWebBff(url.pathname, request)) {
      const bffResponse = await webBff.fetch(
        request,
        env as unknown as Parameters<typeof webBff.fetch>[1],
        ctx,
      );
      if (bffResponse) {
        return bffResponse;
      }
    }

    const httpApiResponse = await handleRagbotHttpApi(request, env, ctx);
    if (httpApiResponse) {
      return httpApiResponse;
    }

    if (url.pathname.startsWith("/client/") || url.pathname.startsWith("/platform/")) {
      return webBff.fetch(request, env as unknown as Parameters<typeof webBff.fetch>[1], ctx);
    }

    if (url.pathname.startsWith("/gateway/")) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET" || request.method === "HEAD") {
      return env.ASSETS.fetch(request);
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
