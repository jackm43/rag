// Ragbot's Discord calls: lookups, pingless replies and interaction responses.
import type { Env } from "./index.ts";
import { interactionMessage, messageBody, type Attachment } from "./lib/discord/messages.ts";
import { botRequest, MessageFlags, truncate } from "./lib/discord/rest.ts";

// Deleted or unknown resources resolve to null.
async function find(env: Env, path: string): Promise<any> {
  const response = await botRequest(env.DISCORD_BOT_TOKEN, path);
  return response.ok ? response.json() : null;
}

export const getMessage = (env: Env, channelId: string, messageId: string) =>
  find(env, `/channels/${channelId}/messages/${messageId}`);

export async function username(env: Env, userId: string): Promise<string | null> {
  try {
    return (await find(env, `/users/${userId}`))?.username ?? null;
  } catch {
    return null;
  }
}

const roleCache = new Map<string, { roles: string[]; expires: number }>();

export async function botRoles(env: Env, guildId: string, botUserId: string): Promise<string[]> {
  const key = `${guildId}:${botUserId}`;
  const cached = roleCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.roles;
  try {
    const member = await find(env, `/guilds/${guildId}/members/${botUserId}`);
    if (member) {
      roleCache.set(key, { roles: member.roles, expires: Date.now() + 300_000 });
      return member.roles;
    }
  } catch {
    // Keep the last known roles.
  }
  return cached?.roles ?? [];
}

/** Reply in a channel without pinging anyone or unfurling links; the text is sent as given. */
export function postMessage(env: Env, channelId: string, content: string, replyTo: string, files: Attachment[] = []) {
  const payload = {
    content,
    allowed_mentions: { parse: [], replied_user: false },
    flags: MessageFlags.SUPPRESS_EMBEDS,
    message_reference: { message_id: replyTo, fail_if_not_exists: false },
  };
  return botRequest(env.DISCORD_BOT_TOKEN, `/channels/${channelId}/messages`, { method: "POST", ...messageBody(payload, files) });
}

/** Edit the deferred interaction reply, or post a follow-up, pinging only `users`. */
export async function reply(
  interaction: any,
  content: string,
  { users, files = [], followup = false }: { users?: string[]; files?: Attachment[]; followup?: boolean } = {},
) {
  const payload = { content: truncate(content, 2000), allowed_mentions: { parse: [], users } };
  const response = await interactionMessage(interaction, payload, { files, followup });
  if (!response.ok) {
    const error: any = await response.json().catch(() => null);
    console.warn(`interaction_write_rejected status=${response.status} code=${error?.code ?? null}`);
  }
  return response.ok;
}

export const guildAllowed = (env: Env, guildId: string | undefined) =>
  env.ALLOWED_GUILD_IDS.split(",").some((id) => id.trim() === guildId);
