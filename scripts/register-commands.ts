import { Routes, SlashCommandBuilder } from "discord.js";

export { };

declare const process: {
  env: Record<string, string | undefined>;
};

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

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
    .setName("ask")
    .setDescription("Start an AI conversation in a new thread")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Question or topic for the new thread")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(6000),
    )
    .addBooleanOption((option) =>
      option
        .setName("web")
        .setDescription("Use web search for current information"),
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

await discordApiRequest(Routes.applicationCommands(applicationId), {
  method: "PUT",
  body: JSON.stringify(commands),
});

type DiscordGuild = {
  id: string;
};

const guilds = await discordApiRequest("/users/@me/guilds");
if (Array.isArray(guilds)) {
  for (const guild of guilds) {
    if (!guild || typeof (guild as DiscordGuild).id !== "string") {
      continue;
    }
    await discordApiRequest(Routes.applicationGuildCommands(applicationId, guild.id), {
      method: "PUT",
      body: JSON.stringify([]),
    });
  }
}
