import { Routes, SlashCommandBuilder } from "discord.js";

export { };

declare const process: {
  env: Record<string, string | undefined>;
};

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const targetGuildId = "457689460096630794";

if (!applicationId || !botToken) {
  throw new Error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required");
}

const commands = [
  new SlashCommandBuilder()
    .setName("rag")
    .setDescription("Record a rag against a user")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("User to mark as ragging")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("ragboard")
    .setDescription("Show the rag leaderboard"),
  new SlashCommandBuilder()
    .setName("ragspend")
    .setDescription("Show your AI ragbot spend"),
  new SlashCommandBuilder()
    .setName("ragspendboard")
    .setDescription("Show the AI ragbot spend leaderboard"),
  new SlashCommandBuilder()
    .setName("raghammer")
    .setDescription("Temporarily block a user from using /rag")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("User to block from /rag")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("timeframe")
        .setDescription("Examples: 5m, 1h, 1d. Use only m, h, or d.")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(12),
    ),
  new SlashCommandBuilder()
    .setName("ragunban")
    .setDescription("Remove a user's current /rag ban")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("User to allow back onto /rag")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("undorag")
    .setDescription("Undo the last rag recorded against a user")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("User whose last rag should be undone")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Start an AI conversation in a new thread")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Question or topic for the new thread")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(6000),
    ),
  new SlashCommandBuilder()
    .setName("bicture")
    .setDescription("Generate an image with Cloudflare AI")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Image prompt")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(2000),
    ),
  new SlashCommandBuilder()
    .setName("ragjam")
    .setDescription("Generate a song with Cloudflare AI")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Music style, mood, and scenario")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(2000),
    )
    .addStringOption((option) =>
      option
        .setName("lyrics")
        .setDescription("Song lyrics; omit to auto-generate lyrics")
        .setRequired(false)
        .setMinLength(1)
        .setMaxLength(3500),
    ),
].map((command) => command.toJSON());

const discordApiRequest = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${botToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Discord API request failed: ${response.status} ${await response.text()}`);
  }

  return response.json().catch(() => null);
};

// Keep commands guild-scoped. This bot is only intended for the target guild,
// and global commands can appear as duplicates beside guild commands.
await discordApiRequest(Routes.applicationCommands(applicationId), {
  method: "PUT",
  body: JSON.stringify([]),
});

await discordApiRequest(Routes.applicationGuildCommands(applicationId, targetGuildId), {
  method: "PUT",
  body: JSON.stringify(commands),
});
