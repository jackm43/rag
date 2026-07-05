import { encodeReplyJobEnvelope, MAX_REPLY_CONTENT_LENGTH } from "../contracts";
import type { Env, ResponderAttachment } from "../contracts";

// Workflows-side producers for Discord egress. Text-only replies travel through
// the durable discord-outbox queue; media-bearing interaction edits go over the
// responder service binding because queue messages cap out at 128 KiB. Both hops
// are trusted by capability (only workflows declares the queue producer and the
// RESPONDER binding), so they carry the plain capnp ReplyJob envelope.

const transportCap = (content: string) => content.slice(0, MAX_REPLY_CONTENT_LENGTH);

export const sendChannelReply = async (
  env: Env,
  channelId: string,
  content: string,
) => {
  if (!env.DISCORD_OUTBOX) {
    throw new Error("DISCORD_OUTBOX binding is required to send channel replies");
  }
  const envelope = encodeReplyJobEnvelope(
    { kind: "reply.channel_message", channelId, content: transportCap(content) },
    { source: "worker" },
  );
  await env.DISCORD_OUTBOX.send(envelope, { contentType: "bytes" });
};

export const sendInteractionEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
) => {
  if (!env.DISCORD_OUTBOX) {
    throw new Error("DISCORD_OUTBOX binding is required to send interaction edits");
  }
  const envelope = encodeReplyJobEnvelope(
    { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
    { source: "worker" },
  );
  await env.DISCORD_OUTBOX.send(envelope, { contentType: "bytes" });
};

export const sendInteractionMediaEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
  attachment: ResponderAttachment,
) => {
  if (!env.RESPONDER) {
    throw new Error("RESPONDER binding is required to send media interaction edits");
  }
  const envelope = encodeReplyJobEnvelope(
    { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
    { source: "worker" },
  );
  await env.RESPONDER.deliverInteractionEdit(envelope, attachment);
};
