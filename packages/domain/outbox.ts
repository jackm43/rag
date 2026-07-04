import { createClient, SYSTEM_SUBJECT, type Subject, type VerifiedRequestContext } from "../auth";
import { encodeReplyJobEnvelope, MAX_REPLY_CONTENT_LENGTH } from "../contracts";
import type { Env, ResponderAttachment } from "../contracts/types";

// Workflows-side producers for Discord egress. Text-only replies travel through
// the durable discord-outbox queue; media-bearing interaction edits go over
// the responder service binding because queue messages cap out at 128 KiB.
// Both hops cross the service boundary as the "workflows" machine principal,
// re-minting an on-behalf-of identity-context token for the original
// requester (the subject); the requester is the verified subject from the
// inbound request, carried through to the downstream token.

const transportCap = (content: string) => content.slice(0, MAX_REPLY_CONTENT_LENGTH);

export type ReplySubject = string | Subject | undefined;

const contextOf = (subject: ReplySubject): VerifiedRequestContext =>
  typeof subject === "object" && subject !== null
    ? {
        subject: subject.sub,
        delegates: subject.delegates,
        requestId: subject.requestId,
        correlationId: subject.correlationId,
      }
    : { subject: subject ?? SYSTEM_SUBJECT };

export const sendChannelReply = async (
  env: Env,
  channelId: string,
  content: string,
  requesterUserId?: ReplySubject,
) => {
  if (!env.DISCORD_OUTBOX) {
    throw new Error("DISCORD_OUTBOX binding is required to send channel replies");
  }

  await createClient({
    env,
    self: "workflows",
    context: contextOf(requesterUserId),
  }).to("responder", { transportTrust: "application" }).call({
    transport: "queue",
    queue: env.DISCORD_OUTBOX,
    envelope: encodeReplyJobEnvelope(
      { kind: "reply.channel_message", channelId, content: transportCap(content) },
      { source: "worker" },
    ),
  });
};

export const sendInteractionEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
  requesterUserId?: ReplySubject,
) => {
  if (!env.DISCORD_OUTBOX) {
    throw new Error("DISCORD_OUTBOX binding is required to send interaction edits");
  }

  await createClient({
    env,
    self: "workflows",
    context: contextOf(requesterUserId),
  }).to("responder", { transportTrust: "application" }).call({
    transport: "queue",
    queue: env.DISCORD_OUTBOX,
    envelope: encodeReplyJobEnvelope(
      { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
      { source: "worker" },
    ),
  });
};

export const sendInteractionMediaEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
  attachment: ResponderAttachment,
  requesterUserId?: ReplySubject,
) => {
  await createClient({
    env,
    self: "workflows",
    context: contextOf(requesterUserId),
  }).to("responder", { transportTrust: "application" }).call({
    transport: "binding",
    env,
    envelope: encodeReplyJobEnvelope(
      { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
      { source: "worker" },
    ),
    attachment,
  });
};
