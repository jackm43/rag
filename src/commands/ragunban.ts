import { commandData } from "../structs/command-data";

import { idOption } from "../lib/interaction";
import type { Command } from "../structs/command";

type DeleteResult = { meta?: { changes?: number } };

export const ragunban: Command = {
  adminOnly: true,
  data: commandData("ragunban", "Remove a user's current /rag ban", [
    { type: 6, name: "user", description: "User to allow back onto /rag", required: true },
  ]),
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
