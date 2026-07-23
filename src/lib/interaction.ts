// Interaction field pluckers shared by the command handlers. A slash command's
// options, invoker, and resolved data are dug out of the raw Discord payload
// once here so handlers never reach into the interaction shape themselves.
// Ported from packages/discord/commands/context.ts + rag-utils.ts.
import type {
  APIApplicationCommandInteractionDataOption,
  APIChatInputApplicationCommandInteraction,
  APIUser,
} from "discord-api-types/v10";

import type { Env } from "../env";
import { fetchUsername } from "./discord";

export type CommandInvoker = { id: string; username: string; global_name?: string | null };

const optionValue = (
  interaction: APIChatInputApplicationCommandInteraction,
  name: string,
): string | number | boolean | undefined => {
  const options: APIApplicationCommandInteractionDataOption[] = interaction.data.options ?? [];
  const option = options.find((candidate) => candidate.name === name);
  return option && "value" in option ? option.value : undefined;
};

// Trimmed string option; empty string when absent or not a string.
export const stringOption = (
  interaction: APIChatInputApplicationCommandInteraction,
  name: string,
): string => {
  const value = optionValue(interaction, name);
  return typeof value === "string" ? value.trim() : "";
};

// Snowflake-ish option coerced to a string; empty string when absent/falsy.
export const idOption = (
  interaction: APIChatInputApplicationCommandInteraction,
  name: string,
): string => {
  const value = optionValue(interaction, name);
  return value ? String(value) : "";
};

export const getInvoker = (
  interaction: APIChatInputApplicationCommandInteraction,
): CommandInvoker | undefined => interaction.member?.user ?? interaction.user;

export const requireInvoker = (
  interaction: APIChatInputApplicationCommandInteraction,
): CommandInvoker => {
  const invoker = getInvoker(interaction);
  if (!invoker) {
    throw new Error("missing_invoker");
  }
  return invoker;
};

export const getInvokerDisplayName = (
  interaction: APIChatInputApplicationCommandInteraction,
): string =>
  interaction.member?.nick?.trim() ||
  interaction.member?.user?.global_name?.trim() ||
  interaction.user?.global_name?.trim() ||
  interaction.member?.user?.username?.trim() ||
  interaction.user?.username?.trim() ||
  "user";

export const getTargetUsername = async (
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env,
  targetId: string,
): Promise<string | null> => {
  const resolved = interaction.data.resolved?.users as Record<string, APIUser> | undefined;
  const targetUser = resolved?.[targetId];
  if (targetUser?.username) {
    return targetUser.username;
  }
  return fetchUsername(env, targetId);
};
