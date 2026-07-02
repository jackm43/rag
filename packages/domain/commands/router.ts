import { handleAskCommand } from "./ask";
import { handleBictureCommand } from "./bicture";
import { handleDeferredRagCommand } from "./rag";
import { handleRagboardCommand } from "./ragboard";
import { handleRagjamCommand } from "./ragjam";
import { handleRagspendCommand, handleRagspendboardCommand } from "./ragspend";
import { handleRaghammerCommand } from "./raghammer";
import { handleRagunbanCommand } from "./ragunban";
import { handleUndoragCommand } from "./undorag";
import { jsonResponse } from "../http";
import { errorMessage, logger } from "../../logger";
import {
  APPLICATION_COMMAND,
  CHANNEL_MESSAGE_WITH_SOURCE,
  PING,
  type DiscordInteraction,
  type Env,
} from "../../contracts/types";

type CommandHandler = (
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

const commandHandlers: Record<string, CommandHandler> = {
  rag: handleDeferredRagCommand,
  ragboard: (_interaction, env) => handleRagboardCommand(env),
  ragspend: (interaction, env) => handleRagspendCommand(interaction, env),
  ragspendboard: (_interaction, env) => handleRagspendboardCommand(env),
  raghammer: (interaction, env) => handleRaghammerCommand(interaction, env),
  ragunban: (interaction, env) => handleRagunbanCommand(interaction, env),
  undorag: (interaction, env) => handleUndoragCommand(interaction, env),
  ask: handleAskCommand,
  bicture: (interaction, env) => handleBictureCommand(interaction, env),
  ragjam: (interaction, env) => handleRagjamCommand(interaction, env),
};

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
    const handler = commandName && Object.hasOwn(commandHandlers, commandName)
      ? commandHandlers[commandName]
      : undefined;
    if (handler) {
      return handler(interaction, env, ctx);
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
