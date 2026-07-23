# ragbot

A personal Discord bot for a single guild, built as one Cloudflare Worker
(`ragbot-worker`) with a Durable Object for the gateway websocket. Commands:
`/rag`, `/ragboard`, `/raghammer`, `/ragunban`, `/undorag`, `/ask`, `/bicture`,
`/ragjam`, `/ragspend`, `/ragspendboard`.

External edges always verify: Discord's Ed25519 signature on `/interactions`,
and a bearer `GATEWAY_CONTROL_TOKEN` on the operator gateway-control routes.
There is no separate auth service, no internal queues, and no signed
worker-to-worker envelopes — it's one process, in-process function calls.

Design background: [docs/superpowers/specs/2026-07-23-single-worker-discord-bot-design.md](docs/superpowers/specs/2026-07-23-single-worker-discord-bot-design.md).
Architecture, conventions, and how to build things live in [AGENTS.md](AGENTS.md).

## Repository layout

```
src/
  index.ts        fetch handler: routes /interactions, gateway control, cron
  env.ts          the Env interface (bindings, vars, secrets)
  commands/       one file per slash command (evobot-style), index.ts registry
  structs/        command/registry types, slash-command builder, the
                   DiscordGateway Durable Object (websocket gateway)
  events/         gateway event handlers (messageCreate → mention handling)
  lib/            Discord REST client, AI (inference/config/spend), D1 access,
                   HTTP/verify helpers, logging, wire contracts/types
scripts/          register-commands.ts (pushes slash commands to Discord)
migrations/       D1 schema (schema.sql is a read-only mirror)
test/             vitest (@cloudflare/vitest-pool-workers)
```

## Prerequisites

- Node **22+** (wrangler requires it) and pnpm.
- `op` (1Password CLI) — `.env` holds `op://` references; run project commands
  through `op run --env-file=.env --`.

Required env (via 1Password): `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`,
`DISCORD_BOT_TOKEN`, `CF_AIG_TOKEN`, `GATEWAY_CONTROL_TOKEN`,
`CLOUDFLARE_API_TOKEN`.

## Everyday commands

```sh
pnpm install
pnpm run check                                # tsc --noEmit
pnpm test                                      # vitest, runs in workerd
op run --env-file=.env -- pnpm run dev         # wrangler dev
op run --env-file=.env -- pnpm run register:commands
pnpm run d1:migrate:local                      # local D1
op run --env-file=.env -- pnpm run d1:migrate:remote
pnpm exec wrangler deploy                      # deploy (also `pnpm run deploy`)
```

## Deploying

```sh
pnpm run deploy    # = wrangler deploy
```

Migrations: `pnpm run d1:migrate:local` / `d1:migrate:remote`. Change the
schema by adding a migration under `migrations/` — never hand-edit
`schema.sql` (it's a read-only mirror). D1 `ragbot` is the bot's durable
data (bans, spend, threads, guild config).

Secrets: `wrangler secret put NAME`.

Note: earlier iterations of this project ran a multi-worker platform (auth
gateway, separate gateway/workflows/responder/spend workers, internal
queues). Those Cloudflare resources are not touched by this repo restructure
and are decommissioned separately, out of band.

## Configuration

- **AI config** is checked into `src/lib/ai/ai-config` (models, prompts,
  temperature, budgets per feature). `loadConfig` reads each file from the
  `AI_CONFIG` KV first (keyed by basename) and falls back to the bundled
  copy, so an empty namespace or KV outage never bricks the bot.
- **AI usage limits** (`src/lib/db/limits.ts`): per-user burst
  (`AI_BURST_LIMIT_PER_MINUTE`, default 8/min) and a global daily budget
  (`AI_GLOBAL_DAILY_BUDGET_USD`, default 10.00). Spend truth is AI Gateway
  log cost, reconciled by `src/lib/ai/reconcile.ts` on the cron trigger.
- **Guild allowlist**: `ALLOWED_GUILD_IDS` (comma-separated snowflakes); fails
  closed when set, allows-with-warning when unset.

## Operating it

- `/interactions` verifies the Discord Ed25519 signature before dispatching
  any command.
- Gateway websocket control (on the `DiscordGateway` Durable Object):
  `POST /gateway/start`, `POST /gateway/stop`, `GET /gateway/health`; all
  require `Authorization: Bearer $GATEWAY_CONTROL_TOKEN`.
- A cron trigger runs AI spend reconciliation periodically.
- Smoke tests after a deploy: `/rag` + `/ragboard` in the guild; `/ask`
  creates a thread with an answer; a mention gets a reply.
