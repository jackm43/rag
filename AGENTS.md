# Working in this repo

Read [README.md](README.md) first. This is one TypeScript Cloudflare Worker, `ragbot-worker`,
with a `DiscordGateway` Durable Object. There are no other Workers, queues, service bindings or
webhook hops.

## Ground rules

- Keep it simple. There are no tests, type-check scripts or CI, on purpose; do not add them,
  or new abstraction layers, unless asked. Delete code that nothing uses instead of keeping it
  for compatibility.
- Wrangler bundles the TypeScript directly. `tsconfig.json` and `@cloudflare/workers-types`
  only serve editors. Prefer inferred types; Discord payloads can stay `any` and are trusted
  after authentication, so read fields directly instead of adding shape checks.
- Verify changes by running them: `op run --env-file=.env -- pnpm run dev`, `pnpm run dev:ui`,
  and `op run --env-file=.env -- pnpm run deploy --dry-run` for packaging or binding changes.
  Deploy with `op run --env-file=.env -- pnpm run deploy` only when asked, and only from the
  root `wrangler.jsonc`, never `wrangler.dev.jsonc`.
- Node 22.18+ and pnpm. Run commands from the repository root through the package scripts
  (`pnpm exec wrangler` for anything else). Pass script arguments directly after the script
  name; keep the `--` that `op run` needs. Development works natively on Windows.
- Secrets come from 1Password through `op run`. Never log or commit them, or resolve them into
  files.

## Layout

- `src/index.ts`: `Env`, the default export (`fetch`, `scheduled`), interaction signature
  verification and the gateway control bearer check.
- `src/gateway.ts`: the `DiscordGateway` Durable Object and the `gateway(env)` stub.
- `src/commands.ts`: the `commands` registry, used for both dispatch and registration.
- `src/chat.ts`: mentions and replies. `src/ai.ts`: D1 settings and model calls.
- `src/discord.ts`: Discord REST, rate limits and replies.
- `dev/`: local-only UI. It may import `src/`; nothing in `src/` imports `dev/`.

To add a command, add an entry to `commands` in `src/commands.ts`. Register commands with
`op run --env-file=.env -- pnpm run register:commands` only when asked.
`scripts/register-commands.mjs` imports `src/commands.ts` with Node's type stripping, so that
module graph must stay free of `cloudflare:workers` imports and non-erasable TypeScript
(enums, namespaces, parameter properties).

## Invariants

- Verify the Discord Ed25519 signature (timestamp plus exact raw body, five-minute window)
  before parsing or dispatching `POST /interactions`.
- `/gateway/start`, `/gateway/stop` and `/gateway/health` require the bearer token and fail
  closed; denials have empty bodies.
- Logs never contain request bodies, headers, tokens or secrets. Log error types, not
  third-party error messages.
- Send credentials only to the fixed Discord, AI and Cloudflare API hosts. Interaction webhook
  URLs contain tokens and are redacted in dev captures.
- D1 `ragbot` is durable data. Change the schema only by adding a migration; keep existing
  resource IDs and migration history.
- AI settings come from a fresh D1 read per AI request; `config/ai/` only seeds new databases
  and is never bundled. There is no AI budget, rate limit or moderation-ban check.
- `/undorag` and `/raghammer` require the Mods role `457695154892177418`; `/ragunban` keeps its
  administrator allowlist. `/rag` bans and writes fail closed on D1 errors.
- Respect Discord retry delays and route/global limits; never retry an ambiguous POST.
- Stream media with the 25 MiB cap and never send Discord credentials to media hosts.
- Keep AI reply text and formatting; disable pings with `allowed_mentions`, suppress link
  previews with message flags, and keep the length limit and empty-reply fallback.
- Keep the class name `DiscordGateway`, the singleton `discord-gateway-v2`, the storage keys
  (`gatewaySession`, `gatewayEnabled`, `gatewayStopped`, `processed:*`) and the Durable Object
  migration history. Never store credentials in Durable Object storage.
- Check the session start limit (`GET /gateway/bot`) before every IDENTIFY. Close codes 4004
  and 4010–4014, and refused handshakes other than 408, 429 and 5xx, stop rapid retries until
  cron or an explicit start. An operator stop persists. Cron and the watchdog never bypass a
  pending reconnect. Clear `gatewaySession` when Discord invalidates the session or on stop.
- Durable Object handler names (`fetch`, `alarm`, `connect`, `webSocket*`) are reserved; do
  not reuse them for other methods.
