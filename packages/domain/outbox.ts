import { peerLinks } from "../boundaries/peer/links";
import { encodeReplyJobEnvelope, MAX_REPLY_CONTENT_LENGTH } from "../contracts";
import { SYSTEM_SUBJECT } from "../identity";
import type { Env, ResponderAttachment } from "../contracts/types";

// Brain-side producers for Discord egress. Text-only replies travel through
// the durable discord-outbox queue; media-bearing interaction edits go over
// the responder service binding because queue messages cap out at 128 KiB.
// Both hops cross the peer boundary as the "brain" identity, re-minting an
// on-behalf-of identity-context token for the original requester (`sub`); the
// requester is the verified actor from the inbound job envelope, so it is
// carried through as the subject of the downstream token.

const transportCap = (content: string) => content.slice(0, MAX_REPLY_CONTENT_LENGTH);

const subjectOf = (requesterUserId: string | undefined) => requesterUserId ?? SYSTEM_SUBJECT;

export const sendChannelReply = async (
  env: Env,
  channelId: string,
  content: string,
  requesterUserId?: string,
) => {
  if (!env.DISCORD_OUTBOX) {
    throw new Error("DISCORD_OUTBOX binding is required to send channel replies");
  }

  await peerLinks(env).brainToResponderOutbox.send(
    env.DISCORD_OUTBOX,
    encodeReplyJobEnvelope(
      { kind: "reply.channel_message", channelId, content: transportCap(content) },
      { source: "worker" },
    ),
    { sub: subjectOf(requesterUserId) },
  );
};

export const sendInteractionEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
  requesterUserId?: string,
) => {
  if (!env.DISCORD_OUTBOX) {
    throw new Error("DISCORD_OUTBOX binding is required to send interaction edits");
  }

  await peerLinks(env).brainToResponderOutbox.send(
    env.DISCORD_OUTBOX,
    encodeReplyJobEnvelope(
      { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
      { source: "worker" },
    ),
    { sub: subjectOf(requesterUserId) },
  );
};

export const sendInteractionMediaEdit = async (
  env: Env,
  applicationId: string,
  interactionToken: string,
  content: string,
  attachment: ResponderAttachment,
  requesterUserId?: string,
) => {
  await peerLinks(env).brainToResponderMedia.send(
    env,
    encodeReplyJobEnvelope(
      { kind: "reply.interaction_edit", applicationId, interactionToken, content: transportCap(content) },
      { source: "worker" },
    ),
    attachment,
    { sub: subjectOf(requesterUserId) },
  );
};
