import type { AiGatewayMetadata } from "./ai";

type BuildAiMetadataOptions = {
  kind: string;
  requestId?: string;
  requesterUserId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
};

export const buildAiGatewayMetadata = ({
  kind,
  requestId,
  requesterUserId,
  channelId,
  messageId,
}: BuildAiMetadataOptions): AiGatewayMetadata => {
  const metadata: AiGatewayMetadata = {
    ragbot_kind: kind,
  };
  if (requestId) {
    metadata.ragbot_request_id = requestId;
  }
  if (requesterUserId) {
    metadata.discord_user_id = requesterUserId;
  }
  if (channelId) {
    metadata.discord_channel_id = channelId;
  }
  if (messageId) {
    metadata.discord_message_id = messageId;
  }
  return metadata;
};
