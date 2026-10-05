# ragbot

A Discord bot running as one TypeScript **Cloudflare Worker**, `ragbot-worker`, with one
`DiscordGateway` Durable Object that holds the Discord gateway WebSocket.
Commands: `/rag`, `/ragboard`, `/raghammer`, `/ragunban`, `/undorag`, `/bicture`, `/coinflip`.
Mentions of the bot and replies to it get an AI answer; when someone asks for a picture, the chat
model calls its `create_picture` tool and the reply carries an image made like `/bicture`'s.

`/undorag` and `/raghammer` require the Mods role (`457695154892177418`). `/ragunban` is limited
to the administrator user IDs in `src/commands.ts`. `/coinflip` uses a fresh cryptographically
secure random bit for every flip.

## Layout

```text
src/index.ts      Worker entrypoint: Env, fetch (interactions + gateway controls), scheduled
src/gateway.ts    DiscordGateway Durable Object: connect, heartbeat, resume, dedupe
src/commands.ts   slash command definitions and dispatch
src/chat.ts       mentions and replies: reply-chain context, AI answer, analytics
src/ai.ts         D1 AI settings, model calls, provider response and image parsing
src/discord.ts    Ragbot's Discord calls: lookups, pingless replies, interaction responses
src/lib/discord/  Discord plumbing with no Ragbot logic: gateway protocol, REST
                  rate limits and retries, interaction signature checks
dev/              local-only dev UI (never deployed)
scripts/          command registration and AI settings initialization
config/ai/        operator inputs for initializing AI settings in D1
migrations/       D1 schema
```

The entrypoint is a plain module Worker that re-exports its Durable Object:

```ts
export { DiscordGateway };

export default {
  async fetch(request, env, ctx) {
    // POST /interactions, plus the bearer-protected /gateway/{start,stop,health}
  },
  async scheduled(_controller, env) {
    await gateway(env).ensureConnected();
  },
} satisfies ExportedHandler<Env>;
```

The Worker and the gateway call each other directly: `gateway(env)` returns the singleton stub
(`env.DISCORD_GATEWAY.getByName("discord-gateway-v2")`), and its public methods `start()`,
`stop()`, `health()` and `ensureConnected()` are called over RPC. Gateway messages are handled
in the Durable Object itself; there are no queues, service bindings or webhook hops.

## Setup

Requires Node 22.18+, pnpm, and the 1Password CLI (`op`). `.env` and `.env.dev` hold `op://`
references, never plaintext secrets; `op run` resolves them for commands that need them.

```sh
pnpm install
pnpm run d1:migrate:local
pnpm run settings:init --local
op run --env-file=.env -- pnpm run dev
```

Wrangler bundles the TypeScript; there is no build, test, type-check or CI step. The AI binding
always runs against Cloudflare, even in local development, so Wrangler needs Cloudflare access
(the `CLOUDFLARE_API_TOKEN` from `.env`, or `wrangler login`).

| Command | Purpose |
| --- | --- |
| `op run --env-file=.env -- pnpm run dev` | Run the bot locally |
| `pnpm run dev:ui` | Local dev UI on http://localhost:8788 (runs `op` itself) |
| `op run --env-file=.env -- pnpm run deploy` | Deploy (`--dry-run` validates packaging) |
| `op run --env-file=.env -- pnpm run d1:migrate:remote` | Apply D1 migrations to production |
| `pnpm run settings:init --local` | Create the local AI settings row if none exists |
| `op run --env-file=.env -- pnpm run settings:init --remote` | Same, for a new production database |
| `op run --env-file=.env -- pnpm run register:commands` | Register slash commands in the guild |

Pass script arguments directly after the script name (`pnpm run deploy --dry-run`); the `--` in
`op run --env-file=.env --` belongs to 1Password. Deploy only `wrangler.jsonc`, never
`wrangler.dev.jsonc`.

The Worker needs the secrets `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` and
`GATEWAY_CONTROL_TOKEN` (declared in `wrangler.jsonc`, so a deploy fails if one is missing).
Locally, `wrangler dev` reads them from the `op run` environment.

## Deploying

```sh
op run --env-file=.env -- pnpm run d1:migrate:remote
op run --env-file=.env -- pnpm run deploy
```

Deployments keep the Worker name, domain, D1 database, Durable Object class, singleton name,
storage keys and migration history. A deploy restarts the gateway object; within a minute its
watchdog alarm reconnects and resumes the stored session, and Discord replays missed events.
After deploying, smoke-test `/rag`, `/ragboard`, a mention and `/bicture`.

## AI settings

Models, prompts and generation settings live in one revisioned D1 row, `ai_runtime_settings`.
Every AI request reads it from the D1 primary, so a saved change applies to the next request
without a redeploy. A failed read stops the request instead of using stale settings.

`config/ai/` only seeds a new database: `pnpm run settings:init --local` (or `--remote`) writes
the row from those files and never overwrites an existing one. To check the live row:

```sh
op run --env-file=.env -- pnpm exec wrangler d1 execute ragbot --remote --command "SELECT revision FROM ai_runtime_settings"
```

Change settings in the dev UI. Chat requests use the provider's default output length.
`reasoningEffort` is sent when set in the chat settings; choosing another model clears it.
AI Gateway logs carry five metadata entries: request kind, Discord user, channel and message
IDs, and the settings revision.

## Dev UI

`pnpm run dev:ui` applies migrations to a separate local database (`.wrangler/dev-state`),
seeds its settings, and serves the UI on **http://localhost:8788**. It needs only
`CLOUDFLARE_API_TOKEN` (resolved from `.env.dev`); Discord credentials are never loaded.

- **Chat** and **/bicture** run the real handlers with real model calls (tagged
  `ragbot_env: dev`) while every Discord request is stubbed and captured. Other commands are
  under **Other commands**.
- **Settings** start on **Live bot**. Pick models from the live Cloudflare catalog (only models
  billable to Cloudflare credits are offered), adjust temperature, history and prompts, then
  **Review & save**. Saves are conditional on the loaded revision, so concurrent edits are
  rejected. **Local sandbox** saves only to the dev database.
- **Prompt history** searches saved chat and `/bicture` prompts and loads one for replay.
- **Request details** show the payload, model requests and responses, Discord calls, logs and
  the database row each run wrote.

The dev Worker has no routes, `workers_dev: false`, a `DEV_UI` guard and a localhost check;
writes require a same-origin JSON request with the UI header. Do not expose it publicly.

## Discord behavior

- Interaction requests are verified (Ed25519 over timestamp plus raw body, five-minute window)
  before parsing. `/coinflip` is answered in the interaction response. Other commands are
  deferred, run in the `DiscordGateway` object (so `/bicture` can outlive the request's 30-second
  `waitUntil` window) and answered by editing the deferred reply. `/rag` bans and writes fail closed on D1 errors.
- Operator routes require `Authorization: Bearer $GATEWAY_CONTROL_TOKEN`:
  `POST /gateway/start`, `POST /gateway/stop`, `GET /gateway/health`. Denials have empty bodies.
- AI replies keep the model's text and formatting, are capped at 1,900 characters, fall back to
  a fixed message when empty, never ping anyone, and suppress link previews.
- Context follows the explicit reply chain in the same channel, up to `historyLimit` messages
  (at most 12); unrelated channel messages are never fetched. Pingless replies to the bot count.
- REST calls respect Discord's route and global rate limits, retry 429s after Discord's delay,
  and retry network errors and 5xx only for idempotent methods: a POST is never replayed.
  Each call gets at most four attempts within 25 seconds.
- Generated media is downloaded without credentials and capped at 25 MiB while streaming.
- Only guilds in `ALLOWED_GUILD_IDS` are served.

## Gateway reliability

- The session (ID, resume URL, sequence, bot user ID) is stored under `gatewaySession`. After a
  restart the object resumes it; `processed:` markers drop replayed duplicates, so the sequence
  is saved on heartbeat ACKs rather than on every event. Markers older than a day are swept.
- Reconnects back off exponentially from 1 second to 5 minutes with jitter, resetting after
  READY or RESUMED. Invalid sessions wait 1–5 seconds; close codes 4003, 4007 and 4009 start a
  new session.
- Every IDENTIFY first checks Discord's session start limit (`GET /gateway/bot`) and waits for
  the reset when it is spent, because exceeding it resets the bot token.
- The socket opens with a `fetch()` upgrade, so refused handshakes report their status: 408,
  429 and 5xx back off (respecting `Retry-After`), a refused resume host starts a new session,
  and anything else stops retries like a fatal close.
- Close codes 4004 and 4010–4014 stop retries until the 15-minute cron or `/gateway/start`.
  An operator stop persists across restarts and cron.
- A one-minute watchdog alarm reconnects after restarts but leaves a pending backoff alone.
- Only `wss://` hosts under `discord.gg` are accepted, because IDENTIFY carries the bot token.
  Credentials are never stored in Durable Object storage.
