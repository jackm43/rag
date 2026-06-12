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
  {
    name: "rag",
    description: "Record a rag against a user",
    options: [
      {
        name: "user",
        description: "User to mark as ragging",
        type: 6,
        required: true,
      },
    ],
  },
  {
    name: "ragboard",
    description: "Show the rag leaderboard",
  },
];

const headers = {
  Authorization: `Bot ${botToken}`,
  "Content-Type": "application/json",
};

const registerCommands = async (url: string, label: string) => {
  const response = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(commands),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} command registration failed: ${response.status} ${text}`);
  }
  const registered = (await response.json()) as Array<{ name: string }>;
  console.info(`${label}: ${registered.map((command) => `/${command.name}`).join(", ") || "(none)"}`);
};

const parseGuildIds = () =>
  (process.env.ALLOWED_GUILD_IDS ?? "")
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

await registerCommands(
  `https://discord.com/api/v10/applications/${applicationId}/commands`,
  "global",
);

for (const guildId of parseGuildIds()) {
  await registerCommands(
    `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
    `guild ${guildId}`,
  );
}
