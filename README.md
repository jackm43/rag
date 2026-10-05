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
src/settings.ts   the typed AI settings document: D1 read and validation
src/ai.ts         Ragbot's model calls: chat with the picture tool, /bicture images
src/discord.ts    Ragbot's Discord calls: lookups, pingless replies, interaction responses
src/lib/          plumbing with no Ragbot logic:
  discord/        gateway protocol, REST rate limits and retries, message bodies and
                  interaction webhooks, interaction signature checks
  ai.ts           Chat Completions, Responses and Workers AI request and response shapes
  media.ts        capped media reads and credential-free downloads
admin/            ragbot-admin: Access-protected admin app (Vite + React, API Worker)
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

Requires Node 22.18+, pnpm, and the 1Password CLI (`op`). `.env` holds `op://`
references, never plaintext secrets; `op run` resolves them for commands that need them.

```sh
pnpm install
pnpm run d1:migrate:local
pnpm run settings:init --local
op run --env-file=.env -- pnpm run dev
```

Wrangler bundles the bot's TypeScript; there is no build, test, type-check or CI step. Only the
admin app has a build, `vite build`, run by its deploy script. The AI binding
always runs against Cloudflare, even in local development, so Wrangler needs Cloudflare access
(the `CLOUDFLARE_API_TOKEN` from `.env`, or `wrangler login`).

| Command | Purpose |
| --- | --- |
| `op run --env-file=.env -- pnpm run dev` | Run the bot locally |
| `op run --env-file=.env -- pnpm run deploy` | Deploy the bot (`--dry-run` validates packaging) |
| `op run --env-file=.env -- pnpm run admin:dev` | Run the admin app locally with Vite |
| `op run --env-file=.env -- pnpm run admin:deploy` | Build and deploy `ragbot-admin` |
| `op run --env-file=.env -- pnpm run admin:sandbox:init` | Migrate and seed the admin sandbox database |
| `op run --env-file=.env -- pnpm run d1:migrate:remote` | Apply D1 migrations to production |
| `pnpm run settings:init --local` | Create the local AI settings row if none exists |
| `op run --env-file=.env -- pnpm run settings:init --remote` | Same, for a new production database |
| `op run --env-file=.env -- pnpm run register:commands` | Register slash commands in the guild |

Pass script arguments directly after the script name (`pnpm run deploy --dry-run`); the `--` in
`op run --env-file=.env --` belongs to 1Password. `pnpm run deploy` deploys only the bot from
the root `wrangler.jsonc`; the admin app deploys only through `pnpm run admin:deploy`.

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

Models, prompts and generation settings live in one revisioned D1 row, `ai_runtime_settings`,
as one JSON document with a `chat` object (model, prompt, temperature, history limit, gateway)
and an `image` object (the active profile and each profile's model, gateway and parameters).
`parseSettings` in `src/settings.ts` checks every field, for the bot and the admin app alike.
Every AI request reads the row from the D1 primary, so a saved change applies to the next
request without a redeploy. A failed read stops the request instead of using stale settings.

`config/ai/` only seeds a new database: `pnpm run settings:init --local` (or `--remote`) writes
the row from `settings.json` and `chat-system-prompt.md` and never overwrites an existing one. To check the live row:

```sh
op run --env-file=.env -- pnpm exec wrangler d1 execute ragbot --remote --command "SELECT revision FROM ai_runtime_settings"
```

Change settings in the admin app. Chat requests use the provider's default output length.
`reasoningEffort` is sent when set in the chat settings; choosing another model clears it.
AI Gateway logs carry five metadata entries: request kind, Discord user, channel and message
IDs, and the settings revision.

## Admin app

`ragbot-admin` is a separate Worker on **https://ragbot-admin.jsmunro.me**, built with Vite, React
and the Cloudflare Vite plugin (`admin/`). Cloudflare Access application **ragbot admin** guards
the hostname with the reusable **GitHub jsmunro org** policy (sign-in with the
`GitHub - jsmunro org` identity provider). The Worker also verifies the Access JWT
(`Cf-Access-Jwt-Assertion`, audience in `admin/wrangler.jsonc`) on every `/api/*` request and
returns an empty 403 without it. It has no `workers.dev` or preview URLs.

It reaches Cloudflare through bindings rather than tokens:

- `LIVE_DB` is the bot's `ragbot` database, for reading and saving its settings and reading
  prompt history. Saves are reviewed first and conditional on the loaded revision, so
  concurrent edits are rejected.
- `DB` is `ragbot-admin-sandbox`. Simulated commands and mentions write there, so `/rag`,
  bans and AI interaction records from testing never reach the bot. **Sandbox** settings live
  there too.
- `AI` runs the real model calls, tagged `ragbot_env: admin` in AI Gateway.

The model catalog and the AI Gateway billing checks have no binding, so they use the
`CLOUDFLARE_API_TOKEN` secret, a read-only token with **Workers AI Read** and
**AI Gateway Read**. Only models billable to Cloudflare credits are offered. Discord
credentials are never configured: every Discord request is stubbed and captured.

- **Chat** and **/bicture** run the real handlers with the saved settings, or the unsaved
  draft when there is one. Every other command has its own tab.
- **Prompt history** searches saved chat and `/bicture` prompts and loads one for replay.
- **Request details** show the payload, model requests and responses, Discord calls, logs and
  the sandbox rows each run wrote.

Local development (`op run --env-file=.env -- pnpm run admin:dev`) serves the app with Vite on
http://localhost:5173 and runs the Worker in workerd with remote D1 bindings. Only
`CLOUDFLARE_API_TOKEN` is read from the environment. The Access check is skipped only for
localhost in `vite dev`; production builds drop that branch.

To change who can sign in, edit the Access application or its policy in Zero Trust.

## Discord behavior

- Interaction requests are verified (Ed25519 over timestamp plus raw body, five-minute window)
  before parsing. Commands run inside the interaction request and answer in its response; one
  still running after 2 seconds defers and edits the deferred reply instead. `/bicture` always
  defers and runs in the `DiscordGateway` object, so it can outlive the request's 30-second
  `waitUntil` window. `/rag` bans and writes fail closed on D1 errors.
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
