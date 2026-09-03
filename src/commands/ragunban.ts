import { SlashCommandBuilder } from "../structs/slash-command-builder";

import { idOption } from "../lib/interaction";
import type { Command } from "../structs/command";

type DeleteResult = { meta?: { changes?: number } };

export const ragunban: Command = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName("ragunban")
    .setDescription("Remove a user's current /rag ban")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to allow back onto /rag").setRequired(true),
    ),
  async execute({ interaction, env, editReply }) {
    const targetId = idOption(interaction, "user");

    const result = (await env.DB.prepare(
      "DELETE FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ?",
    )
      .bind(targetId, new Date().toISOString())
      .run()) as DeleteResult;
    const removedCount = result.meta?.changes ?? 0;

    await editReply({
      content:
        removedCount > 0
          ? `<@${targetId}> can use /rag again.`
          : `<@${targetId}> does not have an active /rag ban.`,
      allowedMentions: { parse: [], users: [targetId] },
    });
  },
};
