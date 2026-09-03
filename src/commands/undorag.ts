import { SlashCommandBuilder } from "../structs/slash-command-builder";

import { idOption } from "../lib/interaction";
import type { Command } from "../structs/command";

type RagEventRow = { id: number };
type RagRow = { rag_count: number };

export const undorag: Command = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName("undorag")
    .setDescription("Undo the last rag recorded against a user")
    .addUserOption((option) =>
      option.setName("user").setDescription("User whose last rag should be undone").setRequired(true),
    ),
  async execute({ interaction, env, editReply }) {
    const targetId = idOption(interaction, "user");

    const latestEvent = await env.DB.prepare(
      "SELECT id FROM rag_events WHERE ragged_user_id = ? ORDER BY id DESC LIMIT 1",
    )
      .bind(targetId)
      .first<RagEventRow>();

    if (!latestEvent) {
      await editReply({
        content: `<@${targetId}> has no rags to undo.`,
        allowedMentions: { parse: [], users: [targetId] },
      });
      return;
    }

    const results = await env.DB.batch<RagRow>([
      env.DB.prepare("DELETE FROM rag_events WHERE id = ?").bind(latestEvent.id),
      env.DB.prepare(
        "UPDATE rag_totals SET rag_count = max(rag_count - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE ragged_user_id = ? RETURNING rag_count",
      ).bind(targetId),
    ]);
    const ragCount = results[1]?.results?.[0]?.rag_count ?? 0;

    await editReply({
      content: `Undid the last rag for <@${targetId}>. Total: ${ragCount}`,
      allowedMentions: { parse: [], users: [targetId] },
    });
  },
};
