import { jsonResponse } from "../http";
import { CHANNEL_MESSAGE_WITH_SOURCE, type Env } from "../../contracts/types";
import { idOption, type CommandContext } from "./context";

type DeleteResult = {
  meta?: {
    changes?: number;
  };
};

export const runRagunbanCommand = async (ctx: CommandContext, env: Env) => {
  const targetId = idOption(ctx, "user");

  const result = (await env.DB.prepare(
    "DELETE FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ?",
  )
    .bind(targetId, new Date(Date.now()).toISOString())
    .run()) as DeleteResult;
  const removedCount = result.meta?.changes ?? 0;

  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content:
        removedCount > 0
          ? `<@${targetId}> can use /rag again.`
          : `<@${targetId}> does not have an active /rag ban.`,
      allowed_mentions: {
        parse: [],
        users: [targetId],
      },
    },
  });
};
