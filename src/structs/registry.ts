import type {
  APIChatInputApplicationCommandInteraction,
  APIInteraction,
} from "discord-api-types/v10";

import { commands } from "../commands";
import type { Env } from "../env";
import { aiBanMessage, activeAiBanForUser } from "../lib/db/bans";
import { GUILD_NOT_ALLOWED_MESSAGE, isGuildAllowed } from "../lib/db/guilds";
import { checkAiUsageAllowed } from "../lib/db/limits";
import {
  DISCORD_API_BASE_URL,
} from "../lib/contracts";
import {
  discordWebhookFetch,
  editOriginalInteractionResponse,
  type InteractionMessageData,
  type InteractionResponseFile,
} from "../lib/discord";
import { errorMessage, logger } from "../lib/logger";
import type { CommandReply } from "./command";

// discord-api-types v10 ships InteractionType as a runtime enum, but esbuild's
// CJS interop resolves it to undefined under the Workers bundler (see the note
// in src/index.ts). Types are erased at build time and unaffected, so we keep
// the typed interaction and hardcode the protocol-stable numeric value.
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;

// Admin membership is data, not code — the rag-admins list. This is what
// changes when an admin is added or removed. Ported from the old
// packages/discord/commands/registry.ts.
export const RAG_ADMIN_USER_IDS = [
  "107426926909517824",
  "116163000339136518",
  "102637456385392640",
  "114128631474683907",
];
const ADMIN_SET = new Set(RAG_ADMIN_USER_IDS);

const toMessageData = (
  message: CommandReply,
): { data: InteractionMessageData; files: InteractionResponseFile[] } => {
  if (typeof message === "string") {
    return { data: { content: message, allowed_mentions: { parse: [] } }, files: [] };
  }
  const files = message.files ?? [];
  const data: InteractionMessageData = {
    content: message.content,
    allowed_mentions: message.allowedMentions ?? { parse: [] },
    ...(files.length > 0
      ? { attachments: files.map((file, index) => ({ id: String(index), filename: file.name })) }
      : {}),
  };
  return { data, files };
};

const buildEditReply =
  (env: Env, applicationId: string, interactionToken: string) =>
  async (message: CommandReply): Promise<void> => {
    const { data, files } = toMessageData(message);
    await editOriginalInteractionResponse(env, applicationId, interactionToken, data, files);
  };

const buildFollowUp =
  (env: Env, applicationId: string, interactionToken: string) =>
  async (message: CommandReply): Promise<void> => {
    const { data, files } = toMessageData(message);
    const url = `${DISCORD_API_BASE_URL}/webhooks/${applicationId}/${interactionToken}`;
    const body =
      files.length > 0
        ? (() => {
            const form = new FormData();
            form.append("payload_json", JSON.stringify(data));
            files.forEach((file, index) => {
              form.append(
                `files[${index}]`,
                new Blob([file.data], { type: file.contentType }),
                file.name,
              );
            });
            return form;
          })()
        : JSON.stringify(data);
    await discordWebhookFetch(url, {
      method: "POST",
      headers: files.length > 0 ? undefined : { "content-type": "application/json" },
      body,
    });
  };

// Resolves a verified interaction to a command and runs it behind the already
// public type-5 deferred ack. Every rejection (guild gate, unknown command,
// admin/ban/usage gate) and every thrown error is surfaced as an edit of the
// deferred reply — the ack was public, so nothing is answered ephemerally, and
// waitUntil must never reject (the edit is best-effort in the catch).
export async function dispatch(
  interaction: APIInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    logger.error("dispatch_missing_interaction_credentials");
    return;
  }

  const editReply = buildEditReply(env, applicationId, interactionToken);
  const followUp = buildFollowUp(env, applicationId, interactionToken);
  let commandName = "unknown";

  try {
    if (interaction.type !== INTERACTION_TYPE_APPLICATION_COMMAND) {
      await editReply("Unsupported interaction.");
      return;
    }

    const commandInteraction = interaction as APIChatInputApplicationCommandInteraction;

    if (!isGuildAllowed(env, commandInteraction.guild_id)) {
      await editReply(GUILD_NOT_ALLOWED_MESSAGE);
      return;
    }

    commandName = commandInteraction.data.name;
    const command = commands.get(commandName);
    if (!command) {
      await editReply("Unknown command.");
      return;
    }

    const invokerId = (commandInteraction.member?.user ?? commandInteraction.user)?.id ?? "";

    if (command.adminOnly && !ADMIN_SET.has(invokerId)) {
      await editReply(`You are not allowed to use /${commandName}.`);
      return;
    }

    if (command.aiLimited && invokerId) {
      const activeBan = await activeAiBanForUser(env, invokerId, new Date());
      if (activeBan) {
        await editReply(aiBanMessage(activeBan.expires_at));
        return;
      }
    }

    if (command.aiLimited) {
      const usage = await checkAiUsageAllowed(env, invokerId || undefined, commandName);
      if (!usage.allowed) {
        await editReply(usage.message);
        return;
      }
    }

    await command.execute({ interaction: commandInteraction, env, ctx, editReply, followUp });
  } catch (error) {
    // waitUntil must never reject: a thrown handler becomes a best-effort edit.
    logger.error("command_execute_failed", { command: commandName, error: errorMessage(error) });
    await editReply("Command failed. Try again.").catch(() => undefined);
  }
}
