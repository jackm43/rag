import { commands } from "../src/commands/index";
import type { SlashCommandJSON } from "../src/structs/slash-command-builder";

// Inlined from discord-api-types' Routes.applicationCommands /
// Routes.applicationGuildCommands (rest/v10). Importing discord.js here (for
// just those two route-string helpers) pulls in discord-api-types' runtime
// enums, which crash under the workerd-backed vitest pool this suite runs
// under — see src/structs/slash-command-builder.ts for the same issue. The
// routes below are plain, stable string templates, confirmed against
// discord-api-types@0.38.49's rest/v10/index.js.
const applicationCommandsRoute = (applicationId: string) => `/applications/${applicationId}/commands`;
const applicationGuildCommandsRoute = (applicationId: string, guildId: string) =>
  `/applications/${applicationId}/guilds/${guildId}/commands`;

export { };

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
};

const targetGuildId = "457689460096630794";

// The single source of truth for the registration payload: each command's
// `data` builder (src/structs/slash-command-builder.ts) is already the source
// of truth for the name the registry keys commands by. Exported so the test
// suite can exercise payload building under Node without touching Discord.
export const buildCommandPayload = (): SlashCommandJSON[] =>
  [...commands.values()].map((command) => command.data.toJSON());

const discordApiRequest = async (botToken: string, path: string, init: RequestInit = {}) => {
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

const main = async () => {
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!applicationId || !botToken) {
    throw new Error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required");
  }

  const payload = buildCommandPayload();

  // Keep commands guild-scoped. This bot is only intended for the target guild,
  // and global commands can appear as duplicates beside guild commands.
  await discordApiRequest(botToken, applicationCommandsRoute(applicationId), {
    method: "PUT",
    body: JSON.stringify([]),
  });

  await discordApiRequest(botToken, applicationGuildCommandsRoute(applicationId, targetGuildId), {
    method: "PUT",
    body: JSON.stringify(payload),
  });
};

// Only run against Discord when this file is executed directly (`pnpm run
// register:commands`), not when imported (e.g. by test/register-payload.test.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
