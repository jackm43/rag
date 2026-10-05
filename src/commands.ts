// Slash commands: `definitions` is what Discord registers and `dispatch` runs them.
import { imageFile, loadSettings, runModel, type Attribution } from "./ai.ts";
import { displayName, guildAllowed, reply, username, type Attachment } from "./discord.ts";
import type { Env } from "./index.ts";
import { truncate } from "./lib/discord/rest.ts";

export const MODS_ROLE_ID = "457695154892177418";
export const ADMIN_IDS = new Set(["107426926909517824", "116163000339136518", "102637456385392640", "114128631474683907"]);

type Context = ReturnType<typeof context>;
type Command = {
  description: string;
  options?: object[];
  admin?: boolean; // limited to ADMIN_IDS
  role?: string; // guild role required to run it
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
      const ban = await env.DB.prepare(
        "SELECT expires_at FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
      )
        .bind(invoker.id, new Date().toISOString())
        .first<{ expires_at: string }>();
      if (ban) return reply(`You cannot use /rag until ${relativeTime(ban.expires_at)}.`);
      const name = await targetName(target);
      const [, totals] = await env.DB.batch<{ rag_count: number }>([
        env.DB.prepare(
          "INSERT INTO rag_events (ragged_user_id, ragged_username, reported_by_user_id, reported_by_username) VALUES (?, ?, ?, ?)",
        ).bind(target, name, invoker.id, invoker.username),
        env.DB.prepare(
          "INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(ragged_user_id) DO UPDATE SET rag_count = rag_count + 1, ragged_username = excluded.ragged_username, updated_at = CURRENT_TIMESTAMP RETURNING rag_count",
        ).bind(target, name),
      ]);
      return reply(`<@${target}> just ragged. Total: ${totals.results[0].rag_count}`, { users: [target] });
    },
  },

  ragboard: {
    description: "Show the rag leaderboard",
    async run({ env, reply }) {
      const { results } = await env.DB.prepare(
        "SELECT ragged_user_id, ragged_username, rag_count FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT 10",
      ).all<{ ragged_user_id: string; ragged_username: string | null; rag_count: number }>();
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
      const latest = await env.DB.prepare("SELECT id FROM rag_events WHERE ragged_user_id = ? ORDER BY id DESC LIMIT 1")
        .bind(target)
        .first<{ id: number }>();
      if (!latest) return reply(`<@${target}> has no rags to undo.`, { users: [target] });
      const [, totals] = await env.DB.batch<{ rag_count: number }>([
        env.DB.prepare("DELETE FROM rag_events WHERE id = ?").bind(latest.id),
        env.DB.prepare(
          "UPDATE rag_totals SET rag_count = max(rag_count - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE ragged_user_id = ? RETURNING rag_count",
        ).bind(target),
      ]);
      const count = totals.results[0]?.rag_count ?? 0;
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
      await env.DB.prepare(
        "INSERT INTO rag_command_bans (banned_user_id, banned_username, banned_by_user_id, banned_by_username, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(target, await targetName(target), invoker.id, invoker.username, new Date(Date.now() + seconds * 1000).toISOString())
        .run();
      return reply(`<@${target}> cannot use /rag for ${match[1]}${match[2]}.`, { users: [target] });
    },
  },

  ragunban: {
    description: "Remove a user's current /rag ban",
    options: [user("User to allow back onto /rag")],
    admin: true,
    async run({ env, option, reply }) {
      const target = option("user");
      const { meta } = await env.DB.prepare("DELETE FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ?")
        .bind(target, new Date().toISOString())
        .run();
      const message = meta.changes ? `<@${target}> can use /rag again.` : `<@${target}> does not have an active /rag ban.`;
      return reply(message, { users: [target] });
    },
  },

  bicture: {
    description: "Generate an image with Cloudflare AI",
    options: [text("prompt", "Image prompt", 2000)],
    async run({ env, option, reply, attribution }) {
      const prompt = option("prompt");
      const source = attribution("bicture");
      const startedAt = Date.now();
      let model = "unknown";
      let status = "ok";
      let error: string | null = null;
      try {
        const settings = await loadSettings(env.DB);
        const image = JSON.parse(settings.resources["bicture-image.json"]);
        const profile = image.profiles[image.activeProfile];
        model = profile.model;
        const parameters = profile.parameters ?? {
          response_format: profile.responseFormat,
          aspect_ratio: profile.aspectRatio,
          quality: profile.quality,
          resolution: profile.resolution,
        };
        const result = await runModel(env, model, { ...parameters, prompt }, profile.gatewayId, source, settings.revision);
        const file = await imageFile(result);
        const summary = prompt.length <= 300 ? prompt : `${truncate(prompt, 299)}...`;
        if (!(await reply(summary, { files: [file] }))) {
          status = "error";
          error = "DiscordUploadRejected";
          await reply("The image was generated, but Discord rejected the upload. Please try again.");
        }
      } catch (caught) {
        status = "error";
        error = caught instanceof Error ? caught.name : "Error";
        console.error(`bicture_command_failed error_type=${error}`);
        await reply("Could not generate that image. Try a different prompt.");
      } finally {
        try {
          await env.DB.prepare(
            "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, model, total_duration_ms, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
            .bind("bicture", source.channelId, source.messageId, source.userId, source.username, prompt, model, Date.now() - startedAt, status, error)
            .run();
        } catch {
          console.warn("interaction_record_failed");
        }
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

function context(env: Env, interaction: any) {
  const invoker = interaction.member?.user ?? interaction.user;
  return {
    env,
    invoker,
    option: (name: string): string =>
      String(interaction.data.options?.find((option: any) => option.name === name)?.value ?? "").trim(),
    reply: (content: string, options?: { users?: string[]; files?: Attachment[] }) => reply(interaction, content, options),
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

/** Run a verified command behind its deferred reply. Never rejects. */
export async function dispatch(env: Env, interaction: any) {
  const ctx = context(env, interaction);
  const name: string = interaction.data.name;
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
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
