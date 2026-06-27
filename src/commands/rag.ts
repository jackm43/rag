import {
  editOriginalInteractionResponse,
  fetchUsername,
  type InteractionMessageData,
} from "../discord";
import { jsonResponse } from "../http";
import { errorMessage, logger } from "../logger";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../types";

type RagRow = {
  rag_count: number;
};

const getInvoker = (interaction: DiscordInteraction) => {
  const user = interaction.member?.user ?? interaction.user;
  if (!user) {
    throw new Error("missing_invoker");
  }
  return user;
};

const getTargetUsername = async (interaction: DiscordInteraction, env: Env, targetId: string) => {
  const targetUser =
    interaction.data?.resolved?.users?.[targetId] ?? interaction.resolved?.users?.[targetId];
  if (targetUser?.username) {
    return targetUser.username;
  }
  return fetchUsername(env, targetId);
};

const buildRagCommandResponseData = async (
  interaction: DiscordInteraction,
  env: Env,
): Promise<InteractionMessageData> => {
  const invoker = getInvoker(interaction);
  const targetIdValue = interaction.data?.options?.find((opt) => opt.name === "user")?.value;
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

export const handleRagCommand = async (interaction: DiscordInteraction, env: Env) =>
  jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: await buildRagCommandResponseData(interaction, env),
  });

export const handleDeferredRagCommand = (
  interaction: DiscordInteraction,
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

  return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
