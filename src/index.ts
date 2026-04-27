import { processAiQueueMessage } from "./commands/ai";
import { handleRagCommand } from "./commands/rag";
import { handleRagboardCommand } from "./commands/ragboard";
import {
  DiscordGateway,
  extractBotMentionPrompt,
  handleGatewayControlRequest,
  handleGatewayMessageCreate,
} from "./discord-gateway";
import { jsonResponse, verifyDiscordRequest } from "./http";
import {
  APPLICATION_COMMAND,
  CHANNEL_MESSAGE_WITH_SOURCE,
  PING,
  type AiJob,
  type Env,
} from "./types";

export { DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/gateway/start" || url.pathname === "/gateway/health") {
      return handleGatewayControlRequest(request, env);
    }

    if (request.method === "GET") {
      return new Response("ok");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
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
        return handleRagCommand(interaction, env);
      }

      if (commandName === "ragboard") {
        return handleRagboardCommand(env);
      }

      return jsonResponse({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Unknown command." },
      });
    } catch {
      return jsonResponse({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Command failed. Try again." },
      });
    }
  },
  async queue(batch: MessageBatch<AiJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processAiQueueMessage(message, env);
    }
  },
};
