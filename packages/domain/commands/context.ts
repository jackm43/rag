import type { DiscordInteraction } from "../../contracts/types";
import { getInvokerDisplayName } from "./rag-utils";

export type CommandOptionValue = string | number | boolean;

export type CommandInvoker = { id: string; username: string; global_name?: string | null };

// Everything a command needs from a Discord interaction, plucked once at the
// boundary so handlers never dig through the raw payload themselves.
export type CommandContext = {
  interaction: DiscordInteraction;
  invoker: CommandInvoker | undefined;
  displayName: string;
  channelId: string | undefined;
  guildId: string | undefined;
  applicationId: string | undefined;
  interactionToken: string | undefined;
  options: Record<string, CommandOptionValue>;
};

export const buildCommandContext = (interaction: DiscordInteraction): CommandContext => {
  const options: Record<string, CommandOptionValue> = {};
  for (const option of interaction.data?.options ?? []) {
    options[option.name] = option.value;
  }

  return {
    interaction,
    invoker: interaction.member?.user ?? interaction.user,
    displayName: getInvokerDisplayName(interaction),
    channelId: interaction.channel_id,
    guildId: interaction.guild_id,
    applicationId: interaction.application_id,
    interactionToken: interaction.token,
    options,
  };
};

export const requireInvoker = (ctx: CommandContext): CommandInvoker => {
  if (!ctx.invoker) {
    throw new Error("missing_invoker");
  }
  return ctx.invoker;
};

// Trimmed string option; empty string when absent or not a string.
export const stringOption = (ctx: CommandContext, name: string) => {
  const value = ctx.options[name];
  return typeof value === "string" ? value.trim() : "";
};

// Snowflake-ish option coerced to a string; empty string when absent/falsy.
export const idOption = (ctx: CommandContext, name: string) => {
  const value = ctx.options[name];
  return value ? String(value) : "";
};

// Presence check used by required-option validation: strings must be
// non-empty after trimming, other values must be truthy.
export const hasOption = (ctx: CommandContext, name: string) => {
  const value = ctx.options[name];
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
};
