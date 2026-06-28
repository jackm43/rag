import { isRagAdminUser } from "../admins";
import { jsonResponse } from "../http";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../types";
import { getInvoker, getOptionValue, getTargetUsername } from "./rag-utils";

const TIMEFRAME_PATTERN = /^([1-9]\d*)([mhd])$/;
const UNIT_MS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const parseTimeframe = (timeframe: string) => {
  const match = TIMEFRAME_PATTERN.exec(timeframe.trim().toLowerCase());
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isSafeInteger(amount)) {
    return null;
  }

  return {
    normalized: `${amount}${unit}`,
    durationMs: amount * UNIT_MS[unit],
  };
};

export const handleRaghammerCommand = async (interaction: DiscordInteraction, env: Env) => {
  const invoker = getInvoker(interaction);
  if (!isRagAdminUser(invoker.id)) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "You are not allowed to use /raghammer.", allowed_mentions: { parse: [] } },
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

  const timeframeValue = getOptionValue(interaction, "timeframe");
  const timeframe = timeframeValue ? String(timeframeValue) : "";
  const parsedTimeframe = parseTimeframe(timeframe);
  if (!parsedTimeframe) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Timeframe must use minutes, hours, or days, like 5m, 1h, or 1d.", allowed_mentions: { parse: [] } },
    });
  }

  const targetUsername = await getTargetUsername(interaction, env, targetId);
  const expiresAt = new Date(Date.now() + parsedTimeframe.durationMs).toISOString();

  await env.DB.prepare(
    "INSERT INTO rag_command_bans (banned_user_id, banned_username, banned_by_user_id, banned_by_username, expires_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(targetId, targetUsername, invoker.id, invoker.username, expiresAt)
    .run();

  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `<@${targetId}> cannot use /rag for ${parsedTimeframe.normalized}.`,
      allowed_mentions: {
        parse: [],
        users: [targetId],
      },
    },
  });
};
