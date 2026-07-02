import type { InteractionMessageData } from "../../discord";
import { authorize } from "../../authz/authorize";
import { activeRagBanForUser, formatBanExpiry } from "../bans";
import { jsonResponse } from "../http";
import { CHANNEL_MESSAGE_WITH_SOURCE, type Env } from "../../contracts/types";
import { idOption, requireInvoker, type CommandContext } from "./context";
import { getTargetUsername } from "./rag-utils";

type RagRow = {
  rag_count: number;
};

// /rag escape hatch: ban lookup plus the D1 write flow run inside the
// deferred window, so it stays a `run` function rather than a buildJob spec.
export const runRagCommand = async (
  ctx: CommandContext,
  env: Env,
): Promise<InteractionMessageData> => {
  const invoker = requireInvoker(ctx);
  const targetId = idOption(ctx, "user");

  // The ban lookup deliberately stays in the deferred window (the registry
  // authorized command.rag before the ban state was known); Cedar makes the
  // actual decision once D1 has answered.
  const activeBan = await activeRagBanForUser(env, invoker.id, new Date());
  const decision = authorize({
    principal: { type: "User", id: invoker.id },
    action: "command.rag",
    resource: { type: "Guild", id: ctx.guildId ?? "unknown" },
    context: { banned: activeBan !== null },
  });
  if (!decision.allowed) {
    return {
      content: activeBan
        ? `You cannot use /rag until ${formatBanExpiry(activeBan.expires_at)}.`
        : "You are not allowed to use /rag.",
      allowed_mentions: { parse: [] },
    };
  }

  const targetUsername = await getTargetUsername(ctx.interaction, env, targetId);

  const results = await env.DB.batch<RagRow>([
    env.DB.prepare(
      "INSERT INTO rag_events (ragged_user_id, ragged_username, reported_by_user_id, reported_by_username) VALUES (?, ?, ?, ?)",
    ).bind(targetId, targetUsername, invoker.id, invoker.username),
    env.DB.prepare(
      "INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(ragged_user_id) DO UPDATE SET rag_count = rag_count + 1, ragged_username = excluded.ragged_username, updated_at = CURRENT_TIMESTAMP RETURNING rag_count",
    ).bind(targetId, targetUsername),
  ]);
  const ragCount = results[1]?.results?.[0]?.rag_count ?? 1;

  return {
    content: `<@${targetId}> just ragged. Total: ${ragCount}`,
    allowed_mentions: {
      parse: [],
      users: [targetId],
    },
  };
};

// Fallback when the interaction carries no application_id/token to defer
// against: answer synchronously instead.
export const runRagCommandInline = async (ctx: CommandContext, env: Env) =>
  jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: await runRagCommand(ctx, env),
  });
