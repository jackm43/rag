// Slash commands: `definitions` is what Discord registers and `dispatch` runs them.
import { generateImage, pictureCaption } from "./ai.ts";
import { banUser, leaderboard, recordInteractions, recordRag, startInteraction, unbanUser, undoRag, type Attribution } from "./data.ts";
import { guildAllowed, reply, username } from "./discord.ts";
import type { Env } from "./index.ts";
import { displayName, type Attachment } from "./lib/discord/messages.ts";
import { loadSettings } from "./settings.ts";

export const MODS_ROLE_ID = "457695154892177418";
export const ADMIN_IDS = new Set(["107426926909517824", "116163000339136518", "102637456385392640", "114128631474683907"]);

type Context = ReturnType<typeof context>;
type Command = {
  description: string;
  options?: object[];
  admin?: boolean; // limited to ADMIN_IDS
  role?: string; // guild role required to run it
  slow?: boolean; // runs in the Durable Object instead of inside the interaction request
  run(ctx: Context): Promise<unknown>;
};

const user = (description: string) => ({ type: 6, name: "user", description, required: true });
const text = (name: string, description: string, max_length: number, min_length = 1) => ({
  type: 3,
  name,
  description,
  required: true,
  min_length,
  max_length,
});

const relativeTime = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : `<t:${Math.floor(ms / 1000)}:R>`;
};

export const commands: Record<string, Command> = {
  rag: {
    description: "Record a rag against a user",
    options: [user("User to mark as ragging")],
    async run({ env, invoker, option, reply, targetName }) {
      const target = option("user");
      const name = await targetName(target);
      const { expiresAt, count } = await recordRag(env.DB, target, name, invoker);
      if (expiresAt) return reply(`You cannot use /rag until ${relativeTime(expiresAt)}.`);
      return reply(`<@${target}> just ragged. Total: ${count}`, { users: [target] });
    },
  },

  ragboard: {
    description: "Show the rag leaderboard",
    async run({ env, reply }) {
      const results = await leaderboard(env.DB);
      if (!results.length) return reply("No rags have been recorded yet.");
      const lines = results.map((row, i) => {
        const mention = `<@${row.ragged_user_id}>`;
        return `${i + 1}. ${row.ragged_username ? `${row.ragged_username} (${mention})` : mention} - ${row.rag_count}`;
      });
      return reply(`Ragboard\n${lines.join("\n")}`);
    },
  },

  undorag: {
    description: "Undo the last rag recorded against a user",
    options: [user("User whose last rag should be undone")],
    role: MODS_ROLE_ID,
    async run({ env, option, reply }) {
      const target = option("user");
      const count = await undoRag(env.DB, target);
      if (count === null) return reply(`<@${target}> has no rags to undo.`, { users: [target] });
      return reply(`Undid the last rag for <@${target}>. Total: ${count}`, { users: [target] });
    },
  },

  raghammer: {
    description: "Temporarily block a user from using /rag",
    options: [user("User to block from /rag"), text("timeframe", "Examples: 5m, 1h, 1d. Use only m, h, or d.", 12, 2)],
    role: MODS_ROLE_ID,
    async run({ env, invoker, option, reply, targetName }) {
      const target = option("user");
      const match = /^([1-9][0-9]*)([mhd])$/.exec(option("timeframe").toLowerCase());
      if (!match || match[1].length > 16 || Number(match[1]) > Number.MAX_SAFE_INTEGER) {
        return reply("Timeframe must use minutes, hours, or days, like 5m, 1h, or 1d.");
      }
      const seconds = Number(match[1]) * { m: 60, h: 3600, d: 86400 }[match[2] as "m" | "h" | "d"];
      if (seconds > 365 * 86400) return reply("Timeframe must be 365d or less.");
      await banUser(env.DB, target, await targetName(target), invoker, new Date(Date.now() + seconds * 1000).toISOString());
      return reply(`<@${target}> cannot use /rag for ${match[1]}${match[2]}.`, { users: [target] });
    },
  },

  ragunban: {
    description: "Remove a user's current /rag ban",
    options: [user("User to allow back onto /rag")],
    admin: true,
    async run({ env, option, reply }) {
      const target = option("user");
      const changed = await unbanUser(env.DB, target);
      const message = changed ? `<@${target}> can use /rag again.` : `<@${target}> does not have an active /rag ban.`;
      return reply(message, { users: [target] });
    },
  },

  bicture: {
    description: "Generate an image with Cloudflare AI",
    options: [text("prompt", "Image prompt", 2000)],
    slow: true,
    async run({ env, option, reply, attribution }) {
      const prompt = option("prompt");
      const source = attribution("bicture");
      const record = startInteraction(source, prompt);
      try {
        const image = await generateImage(env, await loadSettings(env.DB), prompt, record);
        if (!(await reply(pictureCaption(prompt), { files: [image.file] }))) {
          record.error = "DiscordUploadRejected";
          await reply("The image was generated, but Discord rejected the upload. Please try again.");
        }
      } catch (caught) {
        record.error = caught instanceof Error ? caught.name : "Error";
        console.error(`bicture_command_failed error_type=${record.error}`);
        await reply("Could not generate that image. Try a different prompt.");
      } finally {
        await recordInteractions(env.DB, [record]);
      }
    },
  },

  coinflip: {
    description: "Flip a fair coin: heads or tails",
    async run({ reply }) {
      // A fresh cryptographically secure bit gives each side exactly the same probability.
      return reply(crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? "tails" : "heads");
    },
  },
};

export const definitions = Object.entries(commands).map(([name, { description, options }]) => ({ name, description, options }));

type Send = (content: string, options?: { users?: string[]; files?: Attachment[] }) => Promise<boolean>;

function context(env: Env, interaction: any, send: Send) {
  const invoker = interaction.member?.user ?? interaction.user;
  return {
    env,
    invoker,
    option: (name: string): string =>
      String(interaction.data.options?.find((option: any) => option.name === name)?.value ?? "").trim(),
    reply: send,
    attribution: (kind: string): Attribution => ({
      kind,
      userId: invoker.id,
      username: displayName(invoker, interaction.member?.nick),
      channelId: interaction.channel_id,
      messageId: interaction.id,
    }),
    // Prefer the user Discord resolved with the interaction; look anyone else up.
    targetName: async (id: string): Promise<string | null> =>
      interaction.data.resolved?.users?.[id]?.username ?? (await username(env, id)),
  };
}

const find = (name: string) => (Object.hasOwn(commands, name) ? commands[name] : undefined);

/** Slow commands run in the Durable Object; the rest run inside the interaction request. */
export const isSlow = (interaction: any) => find(interaction.data.name)?.slow === true;

/**
 * Run a verified command. Replies edit the deferred response unless `send` says otherwise.
 * Never rejects.
 */
export async function dispatch(
  env: Env,
  interaction: any,
  send: Send = (content, options) => reply(interaction, content, options),
) {
  const ctx = context(env, interaction, send);
  const name: string = interaction.data.name;
  const command = find(name);
  try {
    if (!guildAllowed(env, interaction.guild_id)) await ctx.reply("This bot only works in its home server.");
    else if (!command) await ctx.reply("Unknown command.");
    else if (command.admin && !ADMIN_IDS.has(ctx.invoker.id)) await ctx.reply(`You are not allowed to use /${name}.`);
    else if (command.role && !interaction.member?.roles.includes(command.role)) {
      await ctx.reply(`You are not allowed to use /${name}. The Mods role is required.`);
    } else await command.run(ctx);
  } catch {
    console.error("command_execute_failed");
    await ctx.reply("Command failed. Try again.").catch(() => console.warn("command_failure_notice_failed"));
  }
}
