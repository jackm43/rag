@0x84bf4a759a05daf3;

# Event envelope for every message crossing a Cloudflare Queue.
# Regenerate the compiled module with `npm run contracts:build` (requires the
# native `capnp` compiler, e.g. `brew install capnp`).

struct ChatPayload {
  # thread_start / thread_reply / channel_reply / ask jobs.
  channelId @0 :Text;
  messageId @1 :Text;
  botUserId @2 :Text;
  prompt @3 :Text;
  replyMessageId @4 :Text;
  replyChannelId @5 :Text;
}

struct RagjamPayload {
  applicationId @0 :Text;
  interactionToken @1 :Text;
  channelId @2 :Text;
  prompt @3 :Text;
  lyrics @4 :Text;
}

struct BicturePayload {
  applicationId @0 :Text;
  interactionToken @1 :Text;
  channelId @2 :Text;
  prompt @3 :Text;
}

struct SpendPayload {
  spendEventId @0 :Text;
}

struct MessageReceivedPayload {
  messageId @0 :Text;
  channelId @1 :Text;
  botUserId @2 :Text;
  content @3 :Text;
  mentionUserIds @4 :List(Text);
  mentionRoleIds @5 :List(Text);
  replyMessageId @6 :Text;
  replyChannelId @7 :Text;
}

struct ChannelMessagePayload {
  channelId @0 :Text;
  content @1 :Text;
}

struct InteractionEditPayload {
  applicationId @0 :Text;
  interactionToken @1 :Text;
  content @2 :Text;
}

struct DevProxyCommandOption {
  # One slash-command option as a name/value pair. Values are carried as Text;
  # the command layer coerces them exactly as it does Discord option values.
  name @0 :Text;
  value @1 :Text;
}

struct DevProxyCommandPayload {
  # A command invocation proxied by the dev-proxy worker on behalf of a
  # Cloudflare Access + Better Auth (Discord) browser session. The gateway's DevProxy entrypoint
  # reconstructs a synthetic Discord interaction from this and runs the SAME
  # command pre-flight (Cedar command.* + limits + bans) a real interaction
  # would. `command` is the slash-command name (e.g. "ask"); subjectUserId is
  # the Discord user the command is authorized as.
  command @0 :Text;
  guildId @1 :Text;
  channelId @2 :Text;
  subjectUserId @3 :Text;
  subjectUsername @4 :Text;
  applicationId @5 :Text;
  interactionToken @6 :Text;
  options @7 :List(DevProxyCommandOption);
}

struct EventEnvelope {
  v @0 :UInt16;
  type @1 :Text;
  id @2 :Text;
  occurredAt @3 :Text;
  source @4 :Text;
  actor :group {
    userId @5 :Text;
    username @6 :Text;
  }
  guildId @7 :Text;
  payload :union {
    threadStart @8 :ChatPayload;
    threadReply @9 :ChatPayload;
    channelReply @10 :ChatPayload;
    ragjam @11 :RagjamPayload;
    spend @12 :SpendPayload;
    ask @13 :ChatPayload;
    bicture @14 :BicturePayload;
    replyChannelMessage @15 :ChannelMessagePayload;
    replyInteractionEdit @16 :InteractionEditPayload;
    messageReceived @17 :MessageReceivedPayload;
    devproxyCommand @18 :DevProxyCommandPayload;
  }
}
