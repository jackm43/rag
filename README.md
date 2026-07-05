# ragbot

A personal Discord bot and the small platform it runs on, built entirely on
Cloudflare Workers. One pnpm workspace where **every deployed worker is its own
top-level `apps/<worker>` application** and all shared code lives in
`packages/*`:

- **The bot** — `apps/gateway` (Discord websocket + control routes), `apps/
  workflows` (AI jobs + the deferred-command processor DO), `apps/responder`
  (Discord write policy), `apps/spend` (AI cost accounting). Domain code in
  `packages/discord`. Commands: `/rag`, `/ragboard`, `/raghammer`, `/ask`,
  `/bicture`, `/ragjam`, `/ragspend`, …
- **The webhooks** — `apps/webhooks` (provider webhooks + Discord interaction
  callbacks at `webhooks.jsmunro.me`); signatures are verified by the auth service
  (`AUTH.verifyWebhook`) / inline Ed25519.
- **The edge** — `apps/auth` is the **API Gateway**: every public app binds it as
  `AUTH` and it owns all public authentication (Cloudflare Access, Better Auth
  Discord sessions, operator token) and the authorization policy table. Outbound
  HTTP is in-process (`@rag/outbound`) in the RPC method that needs it.

External edges are verified (Discord Ed25519, Cloudflare Access, provider
webhook HMAC); public requests are authenticated and authorized by the auth
worker, which backends trust and don't re-check. Worker-to-worker calls are
plain, capability-gated Cloudflare service-binding RPC — no signing, no Cedar
(only a worker whose wrangler declares a binding can make the call). Outbound
credentials live on the workers that make the calls; webhook secrets on the auth
worker. Architecture, conventions, and how
to build things live in [AGENTS.md](AGENTS.md).

## Repository layout

```
apps/           one top-level dir per deployed worker:
                auth, gateway, workflows, responder, spend, webhooks
packages/       shared (may never import apps):
                edge-kit (the middleware), auth-kit (auth library),
                discord, contracts-core, outbound,
                rpc, queue-kit, secrets, service-kit (types only), logger
scripts/        deploy, codegen, scaffold, dependency-direction check
migrations/     D1 schema (schema.sql is a read-only mirror)
test/           vitest (@cloudflare/vitest-pool-workers)
```

## Prerequisites

- Node **22+** (wrangler requires it) and pnpm.
- `op` (1Password CLI) — `.env` holds `op://` references; run project commands
  through `op run --env-file=.env --`.
- `brew install capnp` — only if you change the wire schemas
  (`packages/contracts-core/*.capnp`).

Required env (via 1Password): `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`,
`DISCORD_BOT_TOKEN`.

## Everyday commands

```sh
pnpm install
pnpm run check        # tsc + dependency-direction check (packages↛apps, no cycles)
pnpm test             # vitest, runs in workerd via vitest-pool-workers
op run --env-file=.env -- pnpm run dev       # gateway worker locally
op run --env-file=.env -- pnpm run dev:all   # gateway + workflows + responder + spend
pnpm run routes:build     # regenerate the gateway's openapi.yaml/openapi.ts
pnpm run contracts:build  # regenerate capnp modules after editing *.capnp
pnpm scaffold <name>      # generate a complete new top-level application
```

## Deploying

```sh
./deploy.sh    # deploy core set + config:push + d1 migrate + register commands + gateway start
```

`pnpm run deploy` (what deploy.sh calls) discovers every `wrangler.jsonc`
under `apps/` and deploys in binding-safe order: **auth first** (every public
app binds it) → responder → **workflows →
gateway** (the gateway binds workflows' `InteractionSession` processor DO
cross-script) → spend. A discovered worker missing from `DEPLOY_ORDER` in
[scripts/deploy.ts](scripts/deploy.ts) fails the deploy loudly. The webhooks
worker has one-time bootstrap steps and deploys individually:
`pnpm run deploy:webhooks`, or `pnpm run deploy -- --only <names>`.

Migrations: `pnpm run d1:migrate:local` / `d1:migrate:remote`. Change the
schema by adding a migration — never edit `schema.sql` (mirror only). Don't
set `preview_database_id` to the production DB; create `ragbot-preview` if
previews are ever needed.

Secrets go on the worker that needs them:
`wrangler secret put NAME -c <that worker's wrangler.jsonc>`.

### One-time bootstrap (new account/environment)

1. D1: `wrangler d1 create ragbot`, id into the gateway wrangler config, then
   `pnpm run d1:migrate:remote`.
2. Queues (before any deploy that references them):
   `ai-jobs`, `ai-jobs-dlq`, `ai-spend-jobs`, `ai-spend-jobs-dlq`,
   `discord-outbox`, `discord-outbox-dlq`, `webhook-jobs`, `webhook-jobs-dlq`
   (`wrangler queues create <name>`).
3. AI config KV: `wrangler kv namespace create AI_CONFIG`, id into
   `apps/workflows/wrangler.jsonc`, then `pnpm run config:push`.
4. Discord app: scopes `bot` + `applications.commands`; permissions Send
   Messages, Create Public Threads, Send Messages in Threads, Use Slash
   Commands, Read Message History. Interactions endpoint =
   `https://webhooks.jsmunro.me/{clientId}/interactions` (the Discord
   application/client id); the webhooks worker verifies the Ed25519 signature,
   returns a fast type-5 ack, and kicks the `InteractionSession` processor DO.
   Register commands: `pnpm run register:commands`.
5. Auth worker (`apps/auth`, the API Gateway): set the Cloudflare Access vars
   (`CF_ACCESS_TEAM_DOMAIN`; `CF_ACCESS_AUD` secret per Access app) and, for the
   web client, a Discord OAuth app + secrets `DISCORD_CLIENT_ID`,
   `DISCORD_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`; apply the
   Better Auth migrations to the `ragbot-auth` D1
   (`wrangler d1 migrations apply ragbot-auth -c apps/auth/wrangler.jsonc
   --remote`). `GATEWAY_CONTROL_TOKEN` (operator bearer token) and
   `RAG_ADMIN_USER_IDS` also live here.
6. Webhooks: put each provider's webhook secret on the auth worker
   (`wrangler secret put GITHUB_WEBHOOK_SECRET -c apps/auth/wrangler.jsonc`), then
   `pnpm run deploy:webhooks`. This shared ingress carries two concerns, both
   keyed by the caller's client/connector id:
   - Provider webhooks — `https://webhooks.jsmunro.me/{provider}/{connectorId}`
     (e.g. `/github/github-app`); the provider HMAC (verified by the auth worker) is
     the authentication.
   - Discord interaction callbacks —
     `https://webhooks.jsmunro.me/{clientId}/interactions`; the Ed25519
     signature is the authentication, verified against the client's public key
     in the `DISCORD_INTERACTION_PUBLIC_KEYS` var (JSON `{clientId: hexPubKey}`).
     The worker binds workflows' `INTERACTION_SESSION` DO cross-script to kick
     the processor.

   The host is behind Cloudflare Access (service-token only), but the
   `/github/*` and `*/interactions` paths carry a Bypass=Everyone
   Access policy so providers and Discord can POST — the signature at the edge
   is the authentication there. All other paths require the `ragbot-webhooks`
   service token.

## Configuration

- **AI config** is checked into `packages/discord/ai/ai-config` (models, prompts,
  temperature, budgets per feature). The workflows worker reads each file
  from the `AI_CONFIG` KV first (keyed by basename) and falls back to the
  bundled copy, so an empty namespace or KV outage never bricks the bot.
  Values are memoized per isolate: publish a prompt change with
  `pnpm run config:push` (new isolates pick it up) or a redeploy.
- **AI usage limits** (`packages/discord/domain/limits.ts`): per-user burst
  (`AI_BURST_LIMIT_PER_MINUTE`, default 8/min) and a global daily budget
  (`AI_GLOBAL_DAILY_BUDGET_USD`, default 10.00) across all AI ingresses.
  Spend truth is AI Gateway log cost, reconciled by the spend worker.
- **Guild allowlist**: `ALLOWED_GUILD_IDS` (comma-separated snowflakes) on the
  gateway and workflows configs; fails closed when set, allows-with-warning
  when unset.

## Operating it

- Health: every public application worker serves `GET /health` and
  `GET /openapi.json` (unauthenticated discovery) via the shared middleware.
- Gateway websocket control: `POST /gateway/start`, `POST /gateway/stop`
  (kill switch — stays down until the next start), `GET /gateway/health`;
  all require `Authorization: Bearer $GATEWAY_CONTROL_TOKEN`.
- Every DLQ has a consumer that logs `dead_letter_message` (ids and envelope
  kinds only, never content) and acks, so dead letters surface in logs
  instead of accumulating.
- Smoke tests after a deploy: `/rag` + `/ragboard` in the guild; `/ask` creates
  a thread with an answer; a mention gets a reply; a GitHub redelivery to the
  webhook URL → 200 (dedupe), tampered body → 401.
