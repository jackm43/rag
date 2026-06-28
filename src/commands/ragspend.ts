import { jsonResponse } from "../http";
import { formatUsdMicros } from "../spend";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../types";
import { getInvoker } from "./rag-utils";

type SpendTotalRow = {
  requester_user_id: string;
  requester_username: string | null;
  estimated_cost_micros: number;
  event_count: number;
};

export const handleRagspendCommand = async (interaction: DiscordInteraction, env: Env) => {
  const invoker = getInvoker(interaction);
  if (!invoker?.id) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Could not identify the requester.", allowed_mentions: { parse: [] } },
    });
  }

  const row = await env.DB.prepare(
    "SELECT requester_user_id, requester_username, estimated_cost_micros, event_count FROM rag_ai_spend_totals WHERE requester_user_id = ?",
  )
    .bind(invoker.id)
    .first<SpendTotalRow>();

  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `<@${invoker.id}> has spent ${formatUsdMicros(row?.estimated_cost_micros ?? 0)}`,
      allowed_mentions: { parse: [] },
    },
  });
};

export const handleRagspendboardCommand = async (env: Env) => {
  const result = await env.DB.prepare(
    "SELECT requester_user_id, requester_username, estimated_cost_micros, event_count FROM rag_ai_spend_totals ORDER BY estimated_cost_micros DESC, requester_user_id ASC LIMIT 10",
  ).run<SpendTotalRow>();

  const rows = result.results ?? [];
  if (rows.length === 0) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "No AI spend has been recorded yet.", allowed_mentions: { parse: [] } },
    });
  }

  const lines = rows.map((row, index) => {
    const name = row.requester_username?.trim() || `User ${row.requester_user_id}`;
    return `${index + 1}. ${name} - ${formatUsdMicros(row.estimated_cost_micros)}`;
  });

  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `Ragspendboard\n${lines.join("\n")}`, allowed_mentions: { parse: [] } },
  });
};
