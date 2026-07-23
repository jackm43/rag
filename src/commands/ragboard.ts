import { SlashCommandBuilder } from "../structs/slash-command-builder";

import type { Command } from "../structs/command";

type RagboardRow = {
  ragged_user_id: string;
  ragged_username: string | null;
  rag_count: number;
};

export const ragboard: Command = {
  data: new SlashCommandBuilder().setName("ragboard").setDescription("Show the rag leaderboard"),
  async execute({ env, editReply }) {
    const result = await env.DB.prepare(
      "SELECT ragged_user_id, ragged_username, rag_count FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT 10",
    ).run<RagboardRow>();

    const rows = result.results ?? [];
    if (rows.length === 0) {
      await editReply("No rags have been recorded yet.");
      return;
    }

    const lines = rows.map((row, index) => {
      const name = row.ragged_username
        ? `${row.ragged_username} (<@${row.ragged_user_id}>)`
        : `<@${row.ragged_user_id}>`;
      return `${index + 1}. ${name} - ${row.rag_count}`;
    });

    await editReply(`Ragboard\n${lines.join("\n")}`);
  },
};
