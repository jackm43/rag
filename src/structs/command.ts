import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/v10";

import type { Env } from "../env";
import type { InteractionResponseFile } from "../lib/discord";
import type { SlashCommandBuilder } from "./slash-command-builder";

// The message a command hands back to the caller. A bare string is the common
// case (content locked to no mentions); the object form lets a command opt into
// pinging specific users or attach generated media.
export type CommandReply =
  | string
  | {
    content: string;
    allowedMentions?: { parse?: string[]; users?: string[] };
    files?: InteractionResponseFile[];
  };

// Everything a command needs to run: the typed interaction, the worker env, the
// execution context (for waitUntil), and the two reply helpers the registry
// wires to the already-acked deferred (type-5) interaction.
export type CommandContext = {
  interaction: APIChatInputApplicationCommandInteraction;
  env: Env;
  ctx: ExecutionContext;
  // Edits the original deferred reply (@original) — the terminal answer.
  editReply(message: CommandReply): Promise<void>;
  // Posts an additional follow-up message on the interaction webhook.
  followUp(message: CommandReply): Promise<void>;
};

// evobot-style command: its slash-command definition (the single source of
// truth, also consumed by the registration script) plus an execute handler.
// `adminOnly` gates to the rag-admins list; `aiLimited` pays the AI ban + usage
// checks before execute runs.
export interface Command {
  data: SlashCommandBuilder;
  adminOnly?: boolean;
  aiLimited?: boolean;
  execute(ctx: CommandContext): Promise<void>;
}
