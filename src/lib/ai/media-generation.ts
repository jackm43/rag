import type { CommandContext } from "../../structs/command";
import { getInvoker, getInvokerDisplayName } from "../interaction";
import { buildAiGatewayMetadata } from "./ai-metadata";
import { inferenceClient } from "./inference";
import { createAiSpendSourceId, recordAiSpendEvent } from "./spend";

export const generateMedia = async (
  { env, interaction }: Pick<CommandContext, "env" | "interaction">,
  kind: "bicture" | "ragjam",
  config: { model: string; gatewayId: string },
  input: Record<string, unknown>,
) => {
  const sourceId = createAiSpendSourceId();
  const requesterUserId = getInvoker(interaction)?.id;
  const result = await inferenceClient(env).run(config.model, input, {
    gatewayId: config.gatewayId,
    metadata: buildAiGatewayMetadata({ kind, requestId: sourceId, requesterUserId, channelId: interaction.channel_id }),
  });
  await recordAiSpendEvent(env, {
    kind, requesterUserId, requesterUsername: getInvokerDisplayName(interaction),
    model: config.model, unitCount: 1, sourceId,
  });
  return result;
};
