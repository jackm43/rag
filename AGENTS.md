# Working in this repo

Read [README.md](README.md) first. This project is one Cloudflare **Python
Worker**, `ragbot-worker`, with a `DiscordGateway` Durable Object. The optional
`builder/` TypeScript Worker builds and hosts members-only web apps (Cloudflare
Containers, Durable Objects, private R2) behind the `BUILDER` service binding.
Ordinary bot commands remain in-process.

Run `pnpm run check`, `pnpm test`, and `pnpm run test:runtime` before calling
runtime changes done. Run a deployment dry run when changing packaging or
bindings. Node 22+, pnpm, and uv 0.12.3+ are required. Commands using secrets go
through `op run --env-file=.env --`; `pnpm run dev:ui` wraps op itself and also
loads `.env.dev`. On Windows that command uses Docker Desktop. Do not log
secrets or resolve them into committed files.

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

Add AI model/config/prompt files in `src/ragbot/ai_config/` and read via
`ConfigStore` (D1-first; legacy KV/bundled fallback only before initialization).
Live settings use a fresh primary D1 snapshot per AI request. Run `pnpm run build`
after editing resources. `_bundled.py` is generated; do not edit it directly.

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

## Discord app builder

For builder changes, also run `pnpm --dir builder check`, `pnpm --dir builder test`
and `node --test builder/runner/server.test.mjs`. Run `pnpm --dir builder e2e`
(Docker, real container, fake AI Gateway and Discord, real browsers) after
changes to the runner, template, auth, rooms or build flow. Dry-run both Workers
after binding or packaging changes. `docs/discord-builder-setup.md` documents
the runtime contract; `builder/template/AGENTS.md` is the contract given to the
coding agent and must match what the host serves.

- Every app route, asset, API call and WebSocket requires Discord OAuth and
  current guild membership (re-checked within five minutes). Never add another
  way in, public or preview URLs, or a public R2 bucket.
- No credential enters build containers. Model calls go to AI Gateway through
  the outbound handler, which adds `cf-aig-authorization`; npm reads are the
  only other egress. Keep `BuildContainer.outbound = ...` an assignment.
- `fetch` in Workers must not use `redirect: "error"` (unsupported); use
  `"manual"` and treat 3xx as failure.
- The builder has no public control routes; the bot calls `BuilderControl`.
