# Working in this repo

Read [README.md](README.md) first. This project is one Cloudflare **Python
Worker**, `ragbot-worker`, with a `DiscordGateway` Durable Object. There are no
other deployed Workers, internal queues, or service-binding hops.

Run `pnpm run check`, `pnpm test`, and `pnpm run test:runtime` before calling
runtime changes done. Run a deployment dry run when changing packaging or
bindings. Node 22+, pnpm, and uv 0.12.3+ are required. Commands using secrets go
through `op run --env-file=.env --`; `pnpm run dev:ui` wraps op itself and also
loads `.env.dev`. Development and deployment run natively on Windows; Docker
is opt-in via `DEV_UI_DOCKER=1`. Keep uv interpreters, cache, and temporary Worker
bundles on the project drive to avoid the Pyodide cross-drive path bug. Do not
log secrets or resolve them into committed files.

## Tooling and Windows

- Run commands from the repository root. Install with `pnpm install` and
  `uv sync --locked`; use the repository's locked tools through its package
  scripts. No virtual environment activation is needed. Do not substitute
  global Wrangler, `uvx`, or manual pip installs.
- For this `D:` checkout, use `UV_PYTHON_INSTALL_DIR=D:\tools\uv\python` and
  `UV_CACHE_DIR=D:\tools\uv\cache`. These are user-level Windows settings;
  existing terminals and Codex must restart or load them into their process
  environment. See README for the PowerShell setup and interpreter installation.
- `.venv` holds host tools. Pywrangler prepares `.venv-workers` and
  `python_modules` for Pyodide before calling Wrangler. Use
  `uv run pywrangler sync --force` when rebuilding a stale Worker environment.
  Move incompatible environments aside; preserve `.wrangler/state` and
  `.wrangler/dev-state` local databases. Keep runtime-test bundles on `D:` too.
- Start production-code development with
  `op run --env-file=.env -- pnpm run dev`; start the debugging UI with
  `pnpm run dev:ui`. Both support native Windows. Docker is an explicit UI
  option, not the default deployment or development path.
- Validate production packaging with
  `op run --env-file=.env -- pnpm run deploy --dry-run`, then deploy with
  `op run --env-file=.env -- pnpm run deploy` when requested. These use
  Pywrangler; bare Wrangler does not install Python dependencies. Deploy only
  the root production `wrangler.jsonc`, never a staged or dev UI bundle.
- Use `pnpm exec wrangler` for direct D1 operations and `pnpm run types` for
  binding types. Pass pnpm script arguments directly, without an extra `--`
  after the script name; retain the separator required by `op run`.

## Architecture

- `src/entry.py`: HTTP signature/bearer authentication, routing, cron, and
  Worker/Durable Object entrypoints.
- `src/ragbot/env.py`: all application bindings, variables, and secrets.
- `src/ragbot/app.py`: dependency composition, command dispatch and mentions.
- `src/ragbot/commands/`: decorator registry and moderation/chat/media handlers.
  The registry is the single source for dispatch and command registration.
- `src/ragbot/gateway.py`: WebSocket lifecycle, heartbeat, reconnects, dedupe.
- `src/ragbot/discord.py`: Workers-native REST client, attachments, media caps.
- `src/ragbot/discord_http.py`: bounded native retries and Discord rate limits.
- `src/ragbot/ai.py`, `config.py`, `conversation.py`: inference,
  config, shared chat/search routing, reply analytics.
- `src/ragbot/db.py`: parameterized D1 access, bans, guilds, threads.
- `src/ragbot/security.py`, `policy.py`: external auth and Discord output policy.
- `dev/`: local-only UI and simulations. It imports production services, but
  nothing in `src/` may import `dev/`. Its staged bundle has no routes,
  `workers_dev: false`, and a `DEV_UI` guard. Never deploy it.

Use Python dataclasses and explicit dependency injection. `discord-typings`
supplies wire types; do not replace the Durable Object with a socket-based bot
framework. Use the Workers SDK with Python values for D1, KV, AI and RPC.
Explicit `to_js` conversions belong only at raw JavaScript API boundaries.

## Invariants

- Verify Discord Ed25519 signatures on every POST `/interactions` **before**
  parsing/dispatch. Signatures cover the timestamp plus exact raw body bytes.
  Preserve the five-minute timestamp window.
- `/gateway/start`, `/gateway/stop`, `/gateway/health` require the configured
  bearer token. Authentication fails closed. Denials have bare status codes.
- Logs must never contain request bodies, headers, tokens or secrets. Avoid
  logging arbitrary exception messages from third-party libraries.
- Use only the fixed Discord/AI/Cloudflare API hosts at credential injection
  sites. Webhook URLs contain credentials and must be redacted in dev capture.
- D1 `ragbot` is durable data. Change schema through `migrations/` only;
  `schema.sql` is a read-only mirror. Keep existing resource IDs and migration
  history unless explicitly changing infrastructure.
- AI has no budget cap, request limit, spend tracking, or moderation-ban checks.
  `/rag` bans and writes fail closed on D1 errors. Cron maintains the gateway.
- `/undorag` and `/raghammer` require Mods role `457695154892177418`.
  `/ragunban` retains its administrator user allowlist.
- Respect Discord retry delays and global/route limits. Do not retry ambiguous
  POST failures; they may have already created a message or thread.
- Download media with the 25 MiB streaming cap; never replace it with unbounded
  buffering. Discord bot credentials must never accompany provider media.
- Suppress mentions, raw IDs, and URL embeds at the shared AI reply boundary.
- Gateway close codes 4004 and 4010–4014 disable rapid retries. Cron or explicit
  start can retry them. An operator stop persists across eviction and cron.
- Keep `DiscordGateway`, singleton `discord-gateway-v2`, storage keys and
  migration history compatible with existing Durable Objects. Retire stale
  singleton instances rather than allowing duplicate gateway sessions.

## Adding features

Add commands using `@command(...)` in `src/ragbot/commands/` and import the
module in its `__init__.py`. Register with
`op run --env-file=.env -- pnpm run register:commands` only when requested.

AI model/config/prompt settings are read through `ConfigStore` from a fresh
primary D1 snapshot per AI request. D1 must be initialized; there is no runtime
KV or file fallback. `config/ai/` contains operator inputs for explicit D1
initialization only. Do not bundle these files into the Worker. Initialization
must preserve any existing D1 settings.

Regenerate `src/js-stubs` with `pnpm run types` after binding/config changes.
Do not edit generated platform stubs by hand.

## Testing

`pnpm test` focuses on primary command, moderation, conversation, and media
workflows using the actual SQLite migrations and injected HTTP transports.
Keep public HTTP authentication and routing checks in the runtime suite.
`pnpm run test:runtime` runs an isolated local Python Worker with D1 and a
Discord-like WebSocket peer, so FFI bugs are exercised in workerd too. Test
workers and their credentials live only in temporary bundles. No test should
contact live Discord, paid AI models, or production data.

Former multi-worker Cloudflare resources are decommissioned out of band,
never by this repository migration.
