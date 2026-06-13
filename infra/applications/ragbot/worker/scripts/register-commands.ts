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
    type: 1,
    integration_types: [0],
    contexts: [0],
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
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
];

const headers = {
  Authorization: `Bot ${botToken}`,
  "Content-Type": "application/json",
};

const parseGuildIds = () =>
  (process.env.ALLOWED_GUILD_IDS ?? "")
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const registerCommands = async (url: string, label: string, payload: typeof commands) => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
    if (response.status === 429) {
      const body = (await response.json()) as { retry_after?: number };
      const delayMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
      if (attempt >= 5) {
        throw new Error(`${label} command registration rate limited after retries`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${label} command registration failed: ${response.status} ${text}`);
    }
    const registered = (await response.json()) as Array<{ name: string }>;
    console.info(`${label}: ${registered.map((command) => `/${command.name}`).join(", ") || "(none)"}`);
    return registered;
  }
};

const listCommands = async (url: string) => {
  const response = await fetch(url, { headers: { Authorization: `Bot ${botToken}` } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`command list failed: ${response.status} ${text}`);
  }
  return (await response.json()) as Array<{ id: string; name: string }>;
};

const assertNoDuplicates = async (url: string, label: string) => {
  const listed = await listCommands(url);
  const counts = new Map<string, number>();
  for (const command of listed) {
    counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    throw new Error(`${label} has duplicate commands: ${duplicates.map(([name, count]) => `${name} x${count}`).join(", ")}`);
  }
};

const globalUrl = `https://discord.com/api/v10/applications/${applicationId}/commands`;
const guildIds = parseGuildIds();

await registerCommands(globalUrl, "global (clear)", []);

if (guildIds.length > 0) {
  for (const guildId of guildIds) {
    const guildUrl = `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`;
    await registerCommands(guildUrl, `guild ${guildId} (clear)`, []);
    await registerCommands(guildUrl, `guild ${guildId}`, commands);
    await assertNoDuplicates(guildUrl, `guild ${guildId}`);
  }
} else {
  await registerCommands(globalUrl, "global", commands);
  await assertNoDuplicates(globalUrl, "global");
}

await assertNoDuplicates(globalUrl, "global");
