import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/payloads/v10";

import {
  editOriginalInteractionResponse,
  fetchUsername,
  type InteractionMessageData,
} from "../discord";
import { jsonResponse } from "../http";
import { errorMessage, logger } from "../logger";
import type { Env } from "../types";

type RagRow = {
  rag_count: number;
};

const DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DISCORD_RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

const getInvoker = (interaction: APIChatInputApplicationCommandInteraction) => {
  const user = interaction.member?.user ?? interaction.user;
  if (!user) {
    throw new Error("missing_invoker");
  }
  return user;
};

const optionValue = (
  interaction: APIChatInputApplicationCommandInteraction,
  name: string,
) => {
  const option = interaction.data?.options?.find((item) => item.name === name);
  return option && "value" in option ? option.value : undefined;
};

const getTargetUsername = async (
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env,
  targetId: string,
) => {
  const targetUser = interaction.data?.resolved?.users?.[targetId];
  if (targetUser?.username) {
    return targetUser.username;
  }
  return fetchUsername(env, targetId);
};

const buildRagCommandResponseData = async (
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env,
): Promise<InteractionMessageData> => {
  const invoker = getInvoker(interaction);
  const targetIdValue = optionValue(interaction, "user");
  const targetId = targetIdValue ? String(targetIdValue) : "";

  if (!targetId) {
    return { content: "A user mention is required." };
  }

  const targetUsername = await getTargetUsername(interaction, env, targetId);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rag_events (ragged_user_id, ragged_username, reported_by_user_id, reported_by_username) VALUES (?, ?, ?, ?)",
    ).bind(targetId, targetUsername, invoker.id, invoker.username),
    env.DB.prepare(
      "INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(ragged_user_id) DO UPDATE SET rag_count = rag_count + 1, ragged_username = excluded.ragged_username, updated_at = CURRENT_TIMESTAMP",
    ).bind(targetId, targetUsername),
  ]);

  const total = await env.DB.prepare("SELECT rag_count FROM rag_totals WHERE ragged_user_id = ?")
    .bind(targetId)
    .first<RagRow>();
  const ragCount = total?.rag_count ?? 1;

  return {
    content: `<@${targetId}> just ragged. Total: ${ragCount}`,
    allowed_mentions: {
      parse: [],
      users: [targetId],
    },
  };
};

export const handleRagCommand = async (
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env,
) =>
  jsonResponse({
    type: DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
    data: await buildRagCommandResponseData(interaction, env),
  });

export const handleDeferredRagCommand = (
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env,
  ctx: ExecutionContext,
) => {
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    return handleRagCommand(interaction, env);
  }

  ctx.waitUntil(
    (async () => {
      try {
        await editOriginalInteractionResponse(
          applicationId,
          interactionToken,
          await buildRagCommandResponseData(interaction, env),
        );
      } catch (error) {
        logger.error("rag_command_failed", { error: errorMessage(error) });
        await editOriginalInteractionResponse(applicationId, interactionToken, {
          content: "Command failed. Try again.",
          allowed_mentions: { parse: [] },
        }).catch(() => undefined);
      }
    })(),
  );

  return jsonResponse({ type: DISCORD_RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
