import { jsonResponse } from "../http";
import { errorMessage, logger } from "../../logger";
import {
  APPLICATION_COMMAND,
  CHANNEL_MESSAGE_WITH_SOURCE,
  PING,
  type DiscordInteraction,
  type Env,
} from "../../contracts/types";
import { executeCommand, type CommandSpec } from "./registry";
import { commandSpecs } from "./specs";

const registry: ReadonlyMap<string, CommandSpec> = new Map(
  commandSpecs.map((spec) => [spec.name, spec]),
);

export const routeInteraction = async (
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  if (interaction.type === PING) {
    return jsonResponse({ type: PING });
  }

  if (interaction.type !== APPLICATION_COMMAND) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unsupported interaction." },
    });
  }

  try {
    const commandName = interaction.data?.name;
    const spec = commandName ? registry.get(commandName) : undefined;
    if (spec) {
      return executeCommand(spec, interaction, env, ctx);
    }

    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unknown command." },
    });
  } catch (error) {
    logger.error("interaction_failed", { error: errorMessage(error) });
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Command failed. Try again." },
    });
  }
};
