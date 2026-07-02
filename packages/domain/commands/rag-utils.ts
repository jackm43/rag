import { fetchUsername } from "../../discord";
import type { DiscordInteraction, Env } from "../../contracts/types";

export const getInvoker = (interaction: DiscordInteraction) => {
  const user = interaction.member?.user ?? interaction.user;
  if (!user) {
    throw new Error("missing_invoker");
  }
  return user;
};

export const getInvokerDisplayName = (interaction: DiscordInteraction) =>
  interaction.member?.nick?.trim() ||
  interaction.member?.user?.global_name?.trim() ||
  interaction.user?.global_name?.trim() ||
  interaction.member?.user?.username?.trim() ||
  interaction.user?.username?.trim() ||
  "user";

export const getOptionValue = (interaction: DiscordInteraction, optionName: string) =>
  interaction.data?.options?.find((opt) => opt.name === optionName)?.value;

export const getTargetUsername = async (interaction: DiscordInteraction, env: Env, targetId: string) => {
  const targetUser =
    interaction.data?.resolved?.users?.[targetId] ?? interaction.resolved?.users?.[targetId];
  if (targetUser?.username) {
    return targetUser.username;
  }
  return fetchUsername(env, targetId);
};
