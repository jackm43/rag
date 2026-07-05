import { fetchUsername } from "../../discord";
import type { DiscordInteraction, Env } from "../../contracts";

export const getInvokerDisplayName = (interaction: DiscordInteraction) =>
  interaction.member?.nick?.trim() ||
  interaction.member?.user?.global_name?.trim() ||
  interaction.user?.global_name?.trim() ||
  interaction.member?.user?.username?.trim() ||
  interaction.user?.username?.trim() ||
  "user";

export const getTargetUsername = async (interaction: DiscordInteraction, env: Env, targetId: string) => {
  const targetUser =
    interaction.data?.resolved?.users?.[targetId] ?? interaction.resolved?.users?.[targetId];
  if (targetUser?.username) {
    return targetUser.username;
  }
  return fetchUsername(env, "workflows", targetId);
};
