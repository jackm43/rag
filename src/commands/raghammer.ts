import { SlashCommandBuilder } from "../structs/slash-command-builder";

import { idOption, requireInvoker, getTargetUsername } from "../lib/interaction";
import type { Command } from "../structs/command";

const TIMEFRAME_PATTERN = /^([1-9]\d*)([mhd])$/;
const UNIT_MS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export const TIMEFRAME_FORMAT_MESSAGE =
  "Timeframe must use minutes, hours, or days, like 5m, 1h, or 1d.";

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

export const raghammer: Command = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName("raghammer")
    .setDescription("Temporarily block a user from using /rag")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to block from /rag").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("timeframe")
        .setDescription("Examples: 5m, 1h, 1d. Use only m, h, or d.")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(12),
    ),
  async execute({ interaction, env, editReply }) {
    const invoker = requireInvoker(interaction);
    const targetId = idOption(interaction, "user");
    const parsedTimeframe = parseTimeframe(idOption(interaction, "timeframe"));
    if (!parsedTimeframe) {
      await editReply(TIMEFRAME_FORMAT_MESSAGE);
      return;
    }

    const targetUsername = await getTargetUsername(interaction, env, targetId);
    const expiresAt = new Date(Date.now() + parsedTimeframe.durationMs).toISOString();

    await env.DB.prepare(
      "INSERT INTO rag_command_bans (banned_user_id, banned_username, banned_by_user_id, banned_by_username, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(targetId, targetUsername, invoker.id, invoker.username, expiresAt)
      .run();

    await editReply({
      content: `<@${targetId}> cannot use /rag for ${parsedTimeframe.normalized}.`,
      allowedMentions: { parse: [], users: [targetId] },
    });
  },
};
