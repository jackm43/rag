import { CHANNEL_MESSAGE_WITH_SOURCE, type Env } from "../types";
import { jsonResponse } from "../http";

type RagboardRow = {
  ragged_user_id: string;
  ragged_username: string | null;
  rag_count: number;
};

export const handleRagboardCommand = async (env: Env) => {
  const result = await env.DB.prepare(
    "SELECT ragged_user_id, ragged_username, rag_count FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT 10",
  ).run<RagboardRow>();

  const rows = result.results ?? [];
  if (rows.length === 0) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "No rags have been recorded yet." },
    });
  }

  const lines = rows.map((row, index) => {
    const name = row.ragged_username ? `${row.ragged_username} (<@${row.ragged_user_id}>)` : `<@${row.ragged_user_id}>`;
    return `${index + 1}. ${name} - ${row.rag_count}`;
  });

  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `Ragboard\n${lines.join("\n")}` },
  });
};
