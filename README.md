# ragbot

A Discord bot running as one **Cloudflare Python Worker**, `ragbot-worker`, with
one `DiscordGateway` Durable Object maintaining the Discord WebSocket.
Commands: `/rag`, `/ragboard`, `/raghammer`, `/ragunban`, `/undorag`, `/ask`,
`/bicture`, `/ragjam`, `/ragspend`, `/ragspendboard`.

Discord interaction signatures and gateway control bearer tokens are verified at
the external edges. Denials have empty bodies. Commands, mentions, AI calls, and
spend reconciliation run in-process; there are no internal queues or services.

## Setup

- Node **22+**, pnpm, and **uv 0.12.3+**. Python is installed by uv.
- `op` (1Password CLI) for commands using secrets. `.env` and `.env.dev` contain
  `op://` references; do not replace them with plaintext secrets.

```sh
pnpm install
uv sync --locked
pnpm run check
pnpm test
pnpm run test:runtime
```

The Python dependencies are locked in `uv.lock`, including a project-local uv
for the Python Workers build tool. Node is used only for Cloudflare
Wrangler. Python Workers use Pyodide. discord.py imports and its aiohttp
networking work here, but its unmodified gateway heartbeat requires unsupported threads;
see the tested results and reproduction in the migration notes.

## Discord library and Python design

[`discord-typings`](https://github.com/Bluenix2/discord-typings/) replaces the
former `discord-api-types` dependency. It supplies Discord wire types without
owning HTTP, WebSocket connections, or an event loop. A small async
`DiscordClient` uses Workers Fetch with per-route/global rate-limit handling
and bounded retries. The existing Durable Object owns the Discord gateway. See [migration notes](docs/python-workers-migration.md) for the
library decision and validation.

Application services use dataclasses, async methods, a decorator-based command
registry, native dictionaries, and explicit dependency injection. SDK bindings
accept Python values directly; raw JavaScript APIs are isolated to Web Crypto,
WebSockets, multipart files, and capped stream reads.

```text
src/entry.py             Worker and DiscordGateway entrypoints
src/ragbot/commands/     registry and moderation/chat/media commands
src/ragbot/app.py        dispatch and mention handling
src/ragbot/gateway.py    gateway lifecycle, heartbeats, deduplication
src/ragbot/discord.py    Discord REST and capped media downloads
src/ragbot/discord_http.py  native rate limits and bounded retries
src/ragbot/ai.py         inference, attribution, shared /ask routing
src/ragbot/ai_config/    editable JSON configs and Markdown prompts
src/ragbot/config.py     KV overrides with bundled fallbacks
src/ragbot/db.py         D1 access, bans, usage limits, threads
src/ragbot/reconcile.py  cron spend reconciliation
src/ragbot/security.py   external authentication
src/js-stubs/            generated Workers API type hints
migrations/             existing D1 schema migrations
scripts/                registration, local launchers, build and checks
tests/                 pytest and actual Workers runtime integration tests
dev/                   local-only Python debugging UI and browser assets
```

## Everyday commands

```sh
pnpm run build                               # regenerate bundled AI config
pnpm run check                               # Ruff, formatting, mypy, config freshness
pnpm test                                    # Python behavior tests with real SQLite schema
pnpm run test:runtime                         # actual local Python Worker, no live services
pnpm run d1:migrate:local
op run --env-file=.env -- pnpm run dev
pnpm run dev:ui                              # op run loads .env + .env.dev automatically
op run --env-file=.env -- pnpm run register:commands
op run --env-file=.env -- pnpm run d1:migrate:remote
op run --env-file=.env -- pnpm run deploy
pnpm run types                              # regenerate src/js-stubs
```

Registration is guild-scoped and reads the same Python registry as dispatch.
`schema.sql` remains a read-only mirror: change the schema through migrations.

## Local debugging UI

`pnpm run dev:ui` serves the existing console on **http://localhost:8788**.
The Python harness calls the real application handlers, stubs every Discord API
request, and captures model requests, responses, replies, media, logs, and D1
side effects. Model calls are real and tagged `ragbot_env: dev`. Per-run config
overrides are isolated from other simulations and production KV.

Use channel, tracked-thread, or `/ask` thread modes, or any slash command. The
browser retains the draft identity and channel transcripts. Reset local rate
limits clears only the local request log. The UI has its own local database
state at `.wrangler/dev-state`; it never connects to production D1 or KV.

The launcher stages a separate Python bundle under `.wrangler/python-dev`,
refreshes it when source files change, and supplies resolved secrets through the
process environment. It requires the 1Password CLI; the former Node SDK resolver
has been removed. The dev worker has no routes, `workers_dev: false`, and a
`DEV_UI` guard. Production never imports or bundles the harness or UI.

## Configuration and operations

AI models, prompts, and generation settings live in `src/ragbot/ai_config`.
`pnpm run build` generates `_bundled.py`; deployment runs this automatically.
`AI_CONFIG` KV can override resources by basename. Chat/search config is cached
per application instance; invalid overrides and KV outages use bundled defaults.

AI usage limits remain 8 requests per user per minute and a trailing 24-hour
$10 server budget unless overridden by `AI_BURST_LIMIT_PER_MINUTE` and
`AI_GLOBAL_DAILY_BUDGET_USD`. D1 failures deliberately fail open for AI guards.
`ALLOWED_GUILD_IDS` fails closed when configured; an unset value allows with a
warning. Generated-media downloads enforce a 25 MiB cap while streaming.

Operator routes require `Authorization: Bearer $GATEWAY_CONTROL_TOKEN`:
`POST /gateway/start`, `POST /gateway/stop`, and `GET /gateway/health`.
An operator stop persists across eviction and cron runs. Fatal Discord close
codes disable rapid retries; cron or an explicit start can retry. Cron also
reconciles AI Gateway costs and prunes old request logs.

The migration preserves the Worker name, domain, D1/KV identifiers, Durable
Object class and singleton name, storage keys, and migration history. No data
migration is required. A deployment restarts the gateway connection; the next
cron or authenticated `/gateway/start` reconnects it unless explicitly stopped.
After deployment, smoke-test `/rag`, `/ragboard`, `/ask`, mentions, and media.

## Discord request reliability

The native client learns Discord bucket headers and waits on route/global
limits. Rejected requests (HTTP 429) retry using Discord's delay. GET, HEAD,
PUT, DELETE, and PATCH also retry transient network/500/502/503/504 failures.
POST requests are not replayed after ambiguous failures, avoiding duplicate
messages or threads. Each call allows at most four attempts within 25 seconds;
longer rate limits fail promptly while retaining the cooldown for later calls.
Cooldowns are local to a client, so responses from Discord remain authoritative
across Worker isolates. Logs never include request URLs, tokens or payloads.
