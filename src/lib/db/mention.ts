import type { DiscordMessage } from "../contracts";

// Pure mention-token helpers shared by the conversation builder (and, later,
// the mention-handling ingress). The full mention resolver — bot-mention
// detection, gateway MESSAGE_CREATE handling, usage/ban gating — is ported in
// a later task; only these two pure string helpers are needed here.

export const stripMentionTokens = (content: string) =>
  content
    .replace(/<@[!&]?[^>\s]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const getMessageAuthorDisplayName = (message: DiscordMessage) =>
  message.member?.nick?.trim() ||
  message.author?.global_name?.trim() ||
  message.author?.username?.trim() ||
  "user";
