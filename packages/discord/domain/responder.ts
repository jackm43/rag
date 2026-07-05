import { sanitizeAiText } from "../ai/ai";
import { decodeReplyJobEnvelope } from "../contracts";
import { editOriginalInteractionResponse, postChannelMessageForSubject } from "../api";
import { errorMessage, logger } from "@rag/logger";
import { MAX_DISCORD_MESSAGE_LENGTH, type Env, type InteractionEditReplyJob, type ResponderAttachment } from "../contracts";

// The requester subject used to ride a signed token; egress no longer signs a
// subject, so the responder applies replies under a fixed system identity.
const SYSTEM_ACTOR = { sub: "system" };

const DISCORD_MESSAGE_HARD_LIMIT = 2000;
const EMPTY_REPLY_FALLBACK = "I could not generate a response.";

// Model output can carry attacker-chosen links (prompt injection through
// other users' messages), and a rendered embed gives a phishing link the
// bot's authority. Wrapping URLs in <angle brackets> keeps them clickable
// but stops Discord from rendering embeds/previews. Code spans are left
// alone, and already-wrapped URLs are not double-wrapped.
const CODE_SEGMENT_PATTERN = /(```[\s\S]*?```|`[^`\n]*`)/g;
const URL_PATTERN = /<?https?:\/\/[^\s<>]+>?/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,!?;:]+$/;

const wrapBareUrls = (segment: string) =>
  segment.replace(URL_PATTERN, (match) => {
    if (match.startsWith("<")) {
      return match;
    }
    const trailingPunctuation = TRAILING_PUNCTUATION_PATTERN.exec(match)?.[0] ?? "";
    const url = trailingPunctuation ? match.slice(0, -trailingPunctuation.length) : match;
    return `<${url}>${trailingPunctuation}`;
  });

export const suppressUrlEmbeds = (text: string) =>
  text
    .split(CODE_SEGMENT_PATTERN)
    .map((segment, index) => (index % 2 === 1 ? segment : wrapBareUrls(segment)))
    .join("");

// Final output policy for AI-generated channel replies. The responder is the
// single Discord egress choke point: workflows workers ship raw model text and
// this is the only place mention/ID sanitisation, URL embed suppression, and
// the message length cap are applied before anything reaches Discord.
export const finalizeAiReplyText = (value: string) => {
  const text = suppressUrlEmbeds(sanitizeAiText(value));
  return text.length > 0 ? text.slice(0, MAX_DISCORD_MESSAGE_LENGTH) : EMPTY_REPLY_FALLBACK;
};

// Interaction-edit content is command feedback (prompt echoes, failure
// notices), not model output, so it only gets the hard length cap plus the
// allowed_mentions lockdown — matching what the inline handlers enforced.
const truncateInteractionContent = (value: string) => value.slice(0, DISCORD_MESSAGE_HARD_LIMIT);

// Apply a verified interaction-edit job to Discord. Shared by the binding RPC
// entrypoint (media edits) and the outbox queue consumer (text edits); the
// token has already been verified by the time a job reaches here.
const applyInteractionEdit = async (
  env: Env,
  job: InteractionEditReplyJob,
  attachment: ResponderAttachment | null,
) => {
  await editOriginalInteractionResponse(
    env,
    "responder",
    job.applicationId,
    job.interactionToken,
    {
      content: truncateInteractionContent(job.content),
      allowed_mentions: { parse: [] },
      ...(attachment ? { attachments: [{ id: "0", filename: attachment.name }] } : {}),
    },
    attachment ? [attachment] : [],
    SYSTEM_ACTOR,
  );
};

// Only interaction edits may arrive over the binding transport.
const decodeInteractionEdit = (bytes: unknown): InteractionEditReplyJob | null => {
  const job = decodeReplyJobEnvelope(bytes);
  return job?.kind === "reply.interaction_edit" ? job : null;
};

// Binding RPC entrypoint (media edits): reached only over the trusted RESPONDER
// binding, so it takes the plain capnp ReplyJob envelope — no token to verify.
export const deliverInteractionEdit = async (
  env: Env,
  message: unknown,
  attachment: ResponderAttachment | null = null,
) => {
  const job = decodeInteractionEdit(message);
  if (!job) {
    throw new Error("Invalid interaction edit envelope");
  }
  await applyInteractionEdit(env, job, attachment);
};

const isRetryableDiscordStatus = (status: number) => status === 429 || status >= 500;

// discord-outbox queue consumer. Messages are plain capnp ReplyJob bytes crossing
// the trusted workflows -> responder producer/consumer binding.
export const processOutboxMessage = async (message: Message<unknown>, env: Env) => {
  const job = decodeReplyJobEnvelope(message.body);
  if (!job) {
    message.ack();
    return;
  }

  try {
    if (job.kind === "reply.channel_message") {
      const response = await postChannelMessageForSubject(
        env,
        "responder",
        job.channelId,
        finalizeAiReplyText(job.content),
        SYSTEM_ACTOR,
      );
      if (!response.ok) {
        logger.warn("reply_delivery_rejected", { kind: job.kind, status: response.status });
        if (isRetryableDiscordStatus(response.status)) {
          message.retry();
          return;
        }
      }
    } else {
      await applyInteractionEdit(env, job, null);
    }
    message.ack();
  } catch (error) {
    logger.error("reply_delivery_failed", { kind: job.kind, error: errorMessage(error) });
    message.retry();
  }
};
