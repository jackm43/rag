import { isRagAdminUser } from "../admins";
import { jsonResponse } from "../http";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../types";
import { getInvoker, getOptionValue } from "./rag-utils";

type RagEventRow = {
  id: number;
};

type RagRow = {
  rag_count: number;
};

export const handleUndoragCommand = async (interaction: DiscordInteraction, env: Env) => {
  const invoker = getInvoker(interaction);
  if (!isRagAdminUser(invoker.id)) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "You are not allowed to use /undorag.", allowed_mentions: { parse: [] } },
    });
  }

  const targetIdValue = getOptionValue(interaction, "user");
  const targetId = targetIdValue ? String(targetIdValue) : "";
  if (!targetId) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "A user mention is required.", allowed_mentions: { parse: [] } },
    });
  }

  const latestEvent = await env.DB.prepare(
    "SELECT id FROM rag_events WHERE ragged_user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  )
    .bind(targetId)
    .first<RagEventRow>();

  if (!latestEvent) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `<@${targetId}> has no rags to undo.`,
        allowed_mentions: {
          parse: [],
          users: [targetId],
        },
      },
    });
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM rag_events WHERE id = ?").bind(latestEvent.id),
    env.DB.prepare(
      "UPDATE rag_totals SET rag_count = max(rag_count - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE ragged_user_id = ?",
    ).bind(targetId),
  ]);

  const total = await env.DB.prepare("SELECT rag_count FROM rag_totals WHERE ragged_user_id = ?")
    .bind(targetId)
    .first<RagRow>();
  const ragCount = total?.rag_count ?? 0;

  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `Undid the last rag for <@${targetId}>. Total: ${ragCount}`,
      allowed_mentions: {
        parse: [],
        users: [targetId],
      },
    },
  });
};
