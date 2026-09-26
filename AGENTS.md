# Working in this repo

Read [README.md](README.md) first. This project is one Cloudflare **Python
Worker**, `ragbot-worker`, with a `DiscordGateway` Durable Object. There are no
other deployed Workers, internal queues, or service-binding hops.

Run `pnpm run check`, `pnpm test`, and `pnpm run test:runtime` before calling
runtime changes done. Run a deployment dry run when changing packaging or
bindings. Node 22+, pnpm, and uv 0.12.3+ are required. Commands using secrets go
through `op run --env-file=.env --`; `pnpm run dev:ui` wraps op itself and also
loads `.env.dev`. Do not log secrets or resolve them into committed files.

## Architecture

- `src/entry.py`: HTTP signature/bearer authentication, routing, cron, and
  Worker/Durable Object entrypoints.
- `src/ragbot/env.py`: all application bindings, variables, and secrets.
- `src/ragbot/app.py`: dependency composition, command dispatch and mentions.
- `src/ragbot/commands/`: decorator registry and moderation/chat/media handlers.
  The registry is the single source for dispatch and command registration.
- `src/ragbot/gateway.py`: WebSocket lifecycle, heartbeat, reconnects, dedupe.
- `src/ragbot/discord.py`: Workers-native REST client, attachments, media caps.
- `src/ragbot/ai.py`, `config.py`, `conversation.py`, `reconcile.py`: inference,
  config, shared chat/search routing, reply analytics and spend reconciliation.
- `src/ragbot/db.py`: parameterized D1 access, bans, limits, guilds, threads.
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
- AI usage and AI ban checks deliberately fail open on D1 errors. `/rag` writes
  and authentication do not. Cron prunes the burst log after a day.
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

Add AI model/config/prompt files in `src/ragbot/ai_config/` and read via
`ConfigStore` (KV-first, bundled fallback). Run `pnpm run build` after editing
resources. `_bundled.py` is generated; do not edit it directly.

Regenerate `src/js-stubs` with `pnpm run types` after binding/config changes.
Do not edit generated platform stubs by hand.

## Testing

`pnpm test` runs pytest with the actual SQLite migrations, injected HTTP
transports and a fake gateway socket. Test behaviors and security invariants.
`pnpm run test:runtime` runs an isolated local Python Worker with D1 and a
Discord-like WebSocket peer, so FFI bugs are exercised in workerd too. Test
workers and their credentials live only in temporary bundles. No test should
contact live Discord, paid AI models, or production data.

Former multi-worker Cloudflare resources are decommissioned out of band,
never by this repository migration.
