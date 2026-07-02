import { WorkerEntrypoint } from "cloudflare:workers";

import { sanitizeAiText } from "./ai";
import { decodeReplyJobEnvelope } from "./contracts";
import { editOriginalInteractionResponse, postChannelMessage } from "./discord";
import { errorMessage, logger } from "./logger";
import { MAX_DISCORD_MESSAGE_LENGTH, type Env, type ResponderAttachment } from "./types";

const DISCORD_MESSAGE_HARD_LIMIT = 2000;
const EMPTY_REPLY_FALLBACK = "I could not generate a response.";

// Final output policy for AI-generated channel replies. The responder is the
// single Discord egress choke point: brain workers ship raw model text and
// this is the only place mention/ID sanitisation and the message length cap
// are applied before anything reaches Discord.
export const finalizeAiReplyText = (value: string) => {
  const text = sanitizeAiText(value);
  return text.length > 0 ? text.slice(0, MAX_DISCORD_MESSAGE_LENGTH) : EMPTY_REPLY_FALLBACK;
};

// Interaction-edit content is command feedback (prompt echoes, failure
// notices), not model output, so it only gets the hard length cap plus the
// allowed_mentions lockdown — matching what the inline handlers enforced.
const truncateInteractionContent = (value: string) => value.slice(0, DISCORD_MESSAGE_HARD_LIMIT);

export const deliverInteractionEdit = async (
  env: Env,
  envelopeBytes: unknown,
  attachment: ResponderAttachment | null = null,
) => {
  const job = decodeReplyJobEnvelope(envelopeBytes);
  if (!job || job.kind !== "reply.interaction_edit") {
    throw new Error("Invalid interaction edit envelope");
  }

  await editOriginalInteractionResponse(
    env,
    job.applicationId,
    job.interactionToken,
    {
      content: truncateInteractionContent(job.content),
      allowed_mentions: { parse: [] },
      ...(attachment ? { attachments: [{ id: "0", filename: attachment.name }] } : {}),
    },
    attachment ? [attachment] : [],
  );
};

const isRetryableDiscordStatus = (status: number) => status === 429 || status >= 500;

export const processOutboxMessage = async (message: Message<unknown>, env: Env) => {
  const job = decodeReplyJobEnvelope(message.body);
  if (!job) {
    logger.warn("reply_job_invalid");
    message.ack();
    return;
  }

  try {
    if (job.kind === "reply.channel_message") {
      const response = await postChannelMessage(env, job.channelId, finalizeAiReplyText(job.content));
      if (!response.ok) {
        logger.warn("reply_delivery_rejected", { kind: job.kind, status: response.status });
        if (isRetryableDiscordStatus(response.status)) {
          message.retry();
          return;
        }
      }
    } else {
      await deliverInteractionEdit(env, message.body);
    }
    message.ack();
  } catch (error) {
    logger.error("reply_delivery_failed", { kind: job.kind, error: errorMessage(error) });
    message.retry();
  }
};

// Service-binding RPC entrypoint for media-bearing interaction edits. Queue
// messages are capped at 128 KiB, so image/audio attachments are handed over
// directly worker-to-worker instead (no network exposure; callable only via
// the binding). A retry would regenerate the media anyway, so losing queue
// durability here costs nothing.
export class Responder extends WorkerEntrypoint<Env> {
  async deliverInteractionEdit(envelope: Uint8Array, attachment: ResponderAttachment) {
    await deliverInteractionEdit(this.env, envelope, attachment);
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processOutboxMessage(message, env);
    }
  },
};
