import { createClient, createHopIntent, SYSTEM_SUBJECT } from "@rag/service-kit";
import { encodeAiJobEnvelope } from "../../../contracts";
import { fallbackThreadTitle } from "../conversation";
import { createThreadWithoutMessage, fetchChannel, isThreadChannel } from "../../discord";
import { errorMessage, logger } from "@rag/logger";
import { recordAiThread } from "../threads";
import type { Env } from "../../../contracts";
import { stringOption, type CommandContext } from "./context";

export { shouldUseAskWebSearch } from "../../ai/ask-mode";

const resolveThreadParentChannelId = async (env: Env, channelId: string) => {
  const channel = await fetchChannel(env, "workflows", channelId);
  if (channel && isThreadChannel(channel) && channel.parent_id) {
    return channel.parent_id;
  }
  return channelId;
};

// /ask escape hatch: creates the thread over Discord REST before enqueueing
// the AI job, so it runs as a deferred-inline command instead of a plain
// enqueue spec.
export const runAskCommand = async (ctx: CommandContext, env: Env) => {
  const prompt = stringOption(ctx, "prompt");
  const parentChannelId = ctx.channelId;
  if (!parentChannelId) {
    return { content: "Run /ask in a server channel so I can create a thread.", allowed_mentions: { parse: [] } };
  }

  const requester = ctx.invoker;
  const requesterUsername = ctx.displayName;
  const title = fallbackThreadTitle(prompt);
  const targetChannelId = await resolveThreadParentChannelId(env, parentChannelId);
  const thread = await createThreadWithoutMessage(env, "workflows", targetChannelId, title).catch((error) => {
    logger.warn("ask_thread_create_failed", {
      error: errorMessage(error),
      channelId: targetChannelId,
    });
    return null;
  });
  if (!thread) {
    return { content: "I could not create a thread for that question.", allowed_mentions: { parse: [] } };
  }

  await recordAiThread(env, {
    threadId: thread.id,
    parentChannelId: targetChannelId,
    requesterUserId: requester?.id,
    requesterUsername,
    initialPrompt: prompt,
    title,
  });

  await createClient({
    env,
    self: "gateway",
    context: { subject: requester?.id ?? SYSTEM_SUBJECT },
  }).to("workflows", { transportTrust: "trusted" }).call({
    transport: "queue",
    queue: env.AI_JOBS,
    envelope: encodeAiJobEnvelope(
      {
        kind: "ask",
        channelId: thread.id,
        requesterUserId: requester?.id,
        requesterUsername,
        prompt,
      },
      { source: "interactions", guildId: ctx.guildId },
    ),
    intent: createHopIntent({
      action: "command.ask",
      resourceType: "Guild",
      resourceId: ctx.guildId ?? "unknown",
      method: "ask",
    }),
  });

  return {
    content: `Started <#${thread.id}>`,
    allowed_mentions: { parse: [] },
  };
};
