import { REST, type ResponseLike, type RESTOptions } from "@discordjs/rest";
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
    ),
].map((command) => command.toJSON());

const makeDiscordRequest = async (
  url: Parameters<RESTOptions["makeRequest"]>[0],
  init: Parameters<RESTOptions["makeRequest"]>[1],
): Promise<ResponseLike> => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers as HeadersInit,
    body: init.body as BodyInit | null | undefined,
    signal: init.signal as AbortSignal | null | undefined,
  });
  return {
    body: null,
    bodyUsed: response.bodyUsed,
    headers: response.headers as ResponseLike["headers"],
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    arrayBuffer: () => response.arrayBuffer(),
    json: () => response.json(),
    text: () => response.text(),
  };
};

const rest = new REST({
  version: "10",
  makeRequest: makeDiscordRequest,
}).setToken(botToken);

await rest.put(Routes.applicationCommands(applicationId), { body: commands });
