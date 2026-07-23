import { SlashCommandBuilder } from "../structs/slash-command-builder";

import { formatUsdMicros } from "../lib/ai/spend";
import type { Command } from "../structs/command";

type SpendTotalRow = {
  requester_user_id: string;
  requester_username: string | null;
  estimated_cost_micros: number;
  event_count: number;
};

export const ragspendboard: Command = {
  data: new SlashCommandBuilder()
    .setName("ragspendboard")
    .setDescription("Show the AI ragbot spend leaderboard"),
  async execute({ env, editReply }) {
    const result = await env.DB.prepare(
      "SELECT requester_user_id, requester_username, estimated_cost_micros, event_count FROM rag_ai_spend_totals ORDER BY estimated_cost_micros DESC, requester_user_id ASC LIMIT 10",
    ).run<SpendTotalRow>();

    const rows = result.results ?? [];
    if (rows.length === 0) {
      await editReply("No AI spend has been recorded yet.");
      return;
    }

    const lines = rows.map((row, index) => {
      const name = row.requester_username?.trim() || `User ${row.requester_user_id}`;
      return `${index + 1}. ${name} - ${formatUsdMicros(row.estimated_cost_micros)}`;
    });

    await editReply(`Ragspendboard\n${lines.join("\n")}`);
  },
};
