import { SlashCommandBuilder } from "../structs/slash-command-builder";

import { activeRagBanForUser, formatBanExpiry } from "../lib/db/bans";
import { idOption, requireInvoker, getTargetUsername } from "../lib/interaction";
import type { Command } from "../structs/command";

type RagRow = { rag_count: number };

// /rag is a public command; a raghammer ban is the only thing that forbids it.
// The ban lookup plus the D1 write flow run inside the deferred window.
export const rag: Command = {
  data: new SlashCommandBuilder()
    .setName("rag")
    .setDescription("Record a rag against a user")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to mark as ragging").setRequired(true),
    ),
  async execute({ interaction, env, editReply }) {
    const invoker = requireInvoker(interaction);
    const targetId = idOption(interaction, "user");

    const activeBan = await activeRagBanForUser(env, invoker.id, new Date());
    if (activeBan) {
      await editReply(`You cannot use /rag until ${formatBanExpiry(activeBan.expires_at)}.`);
      return;
    }

    const targetUsername = await getTargetUsername(interaction, env, targetId);

    const results = await env.DB.batch<RagRow>([
      env.DB.prepare(
        "INSERT INTO rag_events (ragged_user_id, ragged_username, reported_by_user_id, reported_by_username) VALUES (?, ?, ?, ?)",
      ).bind(targetId, targetUsername, invoker.id, invoker.username),
      env.DB.prepare(
        "INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(ragged_user_id) DO UPDATE SET rag_count = rag_count + 1, ragged_username = excluded.ragged_username, updated_at = CURRENT_TIMESTAMP RETURNING rag_count",
      ).bind(targetId, targetUsername),
    ]);
    const ragCount = results[1]?.results?.[0]?.rag_count ?? 1;

    await editReply({
      content: `<@${targetId}> just ragged. Total: ${ragCount}`,
      allowedMentions: { parse: [], users: [targetId] },
    });
  },
};
