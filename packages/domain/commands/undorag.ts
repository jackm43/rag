import { jsonResponse } from "../http";
import { CHANNEL_MESSAGE_WITH_SOURCE, type Env } from "../../contracts/types";
import { idOption, type CommandContext } from "./context";

type RagEventRow = {
  id: number;
};

type RagRow = {
  rag_count: number;
};

export const runUndoragCommand = async (ctx: CommandContext, env: Env) => {
  const targetId = idOption(ctx, "user");

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

  const results = await env.DB.batch<RagRow>([
    env.DB.prepare("DELETE FROM rag_events WHERE id = ?").bind(latestEvent.id),
    env.DB.prepare(
      "UPDATE rag_totals SET rag_count = max(rag_count - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE ragged_user_id = ? RETURNING rag_count",
    ).bind(targetId),
  ]);
  const ragCount = results[1]?.results?.[0]?.rag_count ?? 0;

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
