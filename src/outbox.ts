import { encodeReplyJobEnvelope, MAX_REPLY_CONTENT_LENGTH } from "./contracts";
import type { Env, ResponderAttachment } from "./types";

// Brain-side producers for Discord egress. Text-only replies travel through
// the durable discord-outbox queue; media-bearing interaction edits go over
// the responder service binding because queue messages cap out at 128 KiB.

const transportCap = (content: string) => content.slice(0, MAX_REPLY_CONTENT_LENGTH);

export const sendChannelReply = async (env: Env, channelId: string, content: string) => {
  if (!env.DISCORD_OUTBOX) {
    throw new Error("DISCORD_OUTBOX binding is required to send channel replies");
  }

  await env.DISCORD_OUTBOX.send(
    encodeReplyJobEnvelope(
      { kind: "reply.channel_message", channelId, content: transportCap(content) },
      { source: "worker" },
    ),
  );
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

  await env.DISCORD_OUTBOX.send(
    encodeReplyJobEnvelope(
      { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
      { source: "worker" },
    ),
  );
};

export const sendInteractionMediaEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
  attachment: ResponderAttachment,
) => {
  if (!env.RESPONDER) {
    throw new Error("RESPONDER service binding is required to send media replies");
  }

  await env.RESPONDER.deliverInteractionEdit(
    encodeReplyJobEnvelope(
      { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
      { source: "worker" },
    ),
    attachment,
  );
};
