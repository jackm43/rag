// Register src/commands.ts with Discord: the guild gets every command, the global scope none.
// Run with `op run --env-file=.env -- pnpm run register:commands`.
import { definitions } from "../src/commands.ts";

const GUILD_ID = "457689460096630794";
const { DISCORD_APPLICATION_ID: application, DISCORD_BOT_TOKEN: token } = process.env;
if (!application || !token) throw new Error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required");

const headers = { authorization: `Bot ${token}`, "content-type": "application/json", "user-agent": "ragbot-worker/1.0" };
const scopes = [
  ["global", `/applications/${application}/commands`, []],
  ["guild", `/applications/${application}/guilds/${GUILD_ID}/commands`, definitions],
];

for (const [scope, path, commands] of scopes) {
  const url = `https://discord.com/api/v10${path}`;
  const saved = await fetch(url, { method: "PUT", headers, body: JSON.stringify(commands) });
  if (!saved.ok) throw new Error(`Discord ${scope} command registration failed (${saved.status})`);
  const current = await fetch(url, { headers });
  if (!current.ok) throw new Error(`Discord ${scope} command readback failed (${current.status})`);
  const names = (list) => list.map((command) => command.name).sort().join(", ");
  if (names(await current.json()) !== names(commands)) throw new Error(`Discord ${scope} commands do not match src/commands.ts`);
  console.log(`Verified ${scope} commands: ${names(commands) || "(none)"}`);
}
