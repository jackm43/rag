import { SlashCommandBuilder } from "../structs/slash-command-builder";

import { formatUsdMicros } from "../lib/ai/spend";
import { requireInvoker } from "../lib/interaction";
import type { Command } from "../structs/command";

type SpendTotalRow = {
  requester_user_id: string;
  requester_username: string | null;
  estimated_cost_micros: number;
  event_count: number;
};

export const ragspend: Command = {
  data: new SlashCommandBuilder().setName("ragspend").setDescription("Show your AI ragbot spend"),
  async execute({ interaction, env, editReply }) {
    const invoker = requireInvoker(interaction);

    const row = await env.DB.prepare(
      "SELECT requester_user_id, requester_username, estimated_cost_micros, event_count FROM rag_ai_spend_totals WHERE requester_user_id = ?",
    )
      .bind(invoker.id)
      .first<SpendTotalRow>();

    await editReply(`<@${invoker.id}> has spent ${formatUsdMicros(row?.estimated_cost_micros ?? 0)}`);
  },
};
