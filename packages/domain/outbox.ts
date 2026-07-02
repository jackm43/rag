import { sendResponderInteractionEdit } from "../boundaries/peer/binding";
import { peerSend } from "../boundaries/peer/queue";
import { encodeReplyJobEnvelope, MAX_REPLY_CONTENT_LENGTH } from "../contracts";
import type { Env, ResponderAttachment } from "../contracts/types";

// Brain-side producers for Discord egress. Text-only replies travel through
// the durable discord-outbox queue; media-bearing interaction edits go over
// the responder service binding because queue messages cap out at 128 KiB.
// Both hops cross the peer boundary as the "brain" identity.

const OUTBOX_SENDER = "brain";

const transportCap = (content: string) => content.slice(0, MAX_REPLY_CONTENT_LENGTH);

export const sendChannelReply = async (env: Env, channelId: string, content: string) => {
  if (!env.DISCORD_OUTBOX) {
    throw new Error("DISCORD_OUTBOX binding is required to send channel replies");
  }

  await peerSend(
    env.DISCORD_OUTBOX,
    encodeReplyJobEnvelope(
      { kind: "reply.channel_message", channelId, content: transportCap(content) },
      { source: "worker" },
    ),
    OUTBOX_SENDER,
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

  await peerSend(
    env.DISCORD_OUTBOX,
    encodeReplyJobEnvelope(
      { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
      { source: "worker" },
    ),
    OUTBOX_SENDER,
  );
};

export const sendInteractionMediaEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
  attachment: ResponderAttachment,
) => {
  await sendResponderInteractionEdit(
    env,
    encodeReplyJobEnvelope(
      { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
      { source: "worker" },
    ),
    attachment,
  );
};
