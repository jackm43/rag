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

const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  const text = await response.text();
  throw new Error(`Command registration failed: ${response.status} ${text}`);
}

await response.json();
