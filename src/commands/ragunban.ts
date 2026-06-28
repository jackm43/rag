import { isRagAdminUser } from "../admins";
import { jsonResponse } from "../http";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../types";
import { getInvoker, getOptionValue } from "./rag-utils";

type DeleteResult = {
  meta?: {
    changes?: number;
  };
};

export const handleRagunbanCommand = async (interaction: DiscordInteraction, env: Env) => {
  const invoker = getInvoker(interaction);
  if (!isRagAdminUser(invoker.id)) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "You are not allowed to use /ragunban.", allowed_mentions: { parse: [] } },
    });
  }

  const targetIdValue = getOptionValue(interaction, "user");
  const targetId = targetIdValue ? String(targetIdValue) : "";
  if (!targetId) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "A user mention is required.", allowed_mentions: { parse: [] } },
    });
  }

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
