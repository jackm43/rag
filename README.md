# ragbot

A personal Discord bot and the small platform it runs on, built entirely on
Cloudflare Workers. Three products share one pnpm workspace:

- **The bot** (`apps/bot`) — rag tracking (`/rag`, `/ragboard`, `/raghammer`,
  `/ragunban`, `/undorag`), AI replies to mentions, thread conversations via
  `/ask`, generative media (`/bicture`, `/ragjam`), and AI spend accounting
  (`/ragspend`, `/ragspendboard`).
- **The connectors platform** (`apps/connectors`) — a credential broker that
  holds every third-party secret (callers get opaque handles, never
  credentials), the shared ingress at `webhooks.jsmunro.me` (provider webhooks
  **and** Discord interaction callbacks), the machine-facing connectors API at
  `connectors.jsmunro.me`, and the dev-proxy admin app at `ragbot-dev.jsmunro.me`
  (Cloudflare Access + Discord OAuth).
- **The control plane** (`apps/platform`) — the application registry
  (`registry.jsmunro.me`), artifact attestation (`attest.jsmunro.me`),
  GraphQL metadata (`metadata.jsmunro.me`), the per-application authority
  (each app is its own OIDC-style issuer minting short-lived act-as tokens),
  and the egress sidecar that owns all outbound-HTTP credentials.

Every external edge is verified (Discord Ed25519, Cloudflare Access, provider
webhook HMAC) and every hop is Cedar-authorized; internal `ServiceMessage` hops
over a Cloudflare service binding or queue are *trusted by capability* (only a
worker whose wrangler declares the binding can make the call) and carry an
unsigned claims-only token, while `http` hops still verify a signature. Security
is enforced at boundaries, not by network topology. Untrusted inbound follows an
**ingress → processor → egress** triad: the shared ingress verifies and acks,
a per-invocation processor Durable Object runs the work, and the egress sidecar
owns every outbound credential. Architecture, conventions, and how to build
things live in [AGENTS.md](AGENTS.md).

## Repository layout

```
apps/
  bot/          workers/{gateway, workflows, responder, spend}
                lib/{domain, discord, ai, ingress}   contracts/
  connectors/   workers/{broker, webhooks, api, dev-proxy}
                lib/ (broker internals)   devproxy-client/   contracts/
  platform/     workers/{registry, attest, metadata, egress}
                lib/{registry-kit, attest-client}   contracts/
packages/       contracts-core, service-kit, authz, ingress, egress,
                secrets, logger        (shared; may never import apps)
scripts/        deploy, codegen, dependency-direction check
cli/            ragctl (dev-proxy CLI)
migrations/     D1 schema (schema.sql is a read-only mirror)
test/           vitest (@cloudflare/vitest-pool-workers)
```

## Prerequisites

- Node **22+** (wrangler requires it) and pnpm.
- `op` (1Password CLI) — `.env` holds `op://` references; run project commands
  through `op run --env-file=.env --`.
- `brew install capnp` — only if you change the wire schemas
  (`packages/contracts-core/*.capnp`).
- `brew install cloudflared` — only for `ragctl login`.

Required env (via 1Password): `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`,
`DISCORD_BOT_TOKEN`.

## Everyday commands

```sh
pnpm install
pnpm run check        # tsc + dependency-direction check (packages↛apps, no cycles)
pnpm test             # vitest, runs in workerd via vitest-pool-workers
op run --env-file=.env -- pnpm run dev       # gateway worker locally
op run --env-file=.env -- pnpm run dev:all   # gateway + workflows + responder + spend
pnpm run routes:build     # regenerate every app's openapi.yaml/openapi.ts (+ gateway routes)
pnpm run contracts:build  # regenerate capnp modules after editing *.capnp
pnpm run scaffold         # generate a new application, service worker, or connector
```

## Deploying

```sh
./deploy.sh    # deploy core set + config:push + d1 migrate + register commands + gateway start
```

`pnpm run deploy` (what deploy.sh calls) discovers every `wrangler.jsonc`
under `apps/` and deploys in binding-safe order: egress → connectors →
connectors-api → responder → **attest → registry** (registry binds attest's
AttestationStore DO) → metadata → **workflows → gateway** (the gateway binds
workflows' `InteractionSession` processor DO cross-script) → spend. A
discovered worker missing from `DEPLOY_ORDER` in
[scripts/deploy.ts](scripts/deploy.ts) fails the deploy loudly. The dev-proxy
and webhooks workers have one-time bootstrap steps and deploy individually:
`pnpm run deploy:dev-proxy`, `pnpm run deploy:webhooks`, or
`pnpm run deploy -- --only <names>`.

Migrations: `pnpm run d1:migrate:local` / `d1:migrate:remote`. Change the
schema by adding a migration — never edit `schema.sql` (mirror only). Don't
set `preview_database_id` to the production DB; create `ragbot-preview` if
previews are ever needed.

Secrets go on the worker that needs them:
`wrangler secret put NAME -c <that worker's wrangler.jsonc>`. Signing keys:
`tsx scripts/generate-keys.ts <worker>`, commit the public JWK to
`packages/service-kit/identity/keyring.ts`, put the private JWK as
`<WORKER>_SIGNING_KEY`.

### One-time bootstrap (new account/environment)

1. D1: `wrangler d1 create ragbot`, id into the gateway wrangler config, then
   `pnpm run d1:migrate:remote`.
2. Queues (before any deploy that references them):
   `ai-jobs`, `ai-jobs-dlq`, `ai-spend-jobs`, `ai-spend-jobs-dlq`,
   `discord-outbox`, `discord-outbox-dlq`, `webhook-jobs`, `webhook-jobs-dlq`,
   `application-grants`, `application-grants-dlq` (the registry worker's
   control-plane grant queue) (`wrangler queues create <name>`).
3. AI config KV: `wrangler kv namespace create AI_CONFIG`, id into
   `apps/bot/workers/workflows/wrangler.jsonc`, then `pnpm run config:push`.
4. Discord app: scopes `bot` + `applications.commands`; permissions Send
   Messages, Create Public Threads, Send Messages in Threads, Use Slash
   Commands, Read Message History. Interactions endpoint =
   `https://webhooks.jsmunro.me/{clientId}/interactions` (the Discord
   application/client id); the webhooks worker verifies the Ed25519 signature,
   returns a fast type-5 ack, and kicks the `InteractionSession` processor DO.
   Register commands: `pnpm run register:commands`.
5. Dev-proxy: Cloudflare Access self-hosted app on `ragbot-dev.jsmunro.me`
   (GitHub org + email allow policy); set `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`
   vars; Discord OAuth app with redirect
   `https://ragbot-dev.jsmunro.me/api/auth/callback/discord`; secrets
   `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `BETTER_AUTH_SECRET`,
   `DEV_PROXY_SIGNING_KEY`; apply the Better Auth migrations to the standalone
   `ragbot-auth` D1 (`wrangler d1 migrations apply ragbot-auth -c <dev-proxy
   config> --remote`). `DEV_PROXY_ALLOWED_SUBJECTS` (the Discord ids the proxy
   may act as) lives on the **gateway** worker and denies all when unset.
6. Webhooks: keypair via `generate-keys.ts webhooks` (public half into the
   `SERVICE_PUBLIC_KEYS` var on workflows + broker), broker deployed first
   with `GITHUB_WEBHOOK_SECRET`, then workflows, then
   `pnpm run deploy:webhooks` + `WEBHOOKS_SIGNING_KEY`. This shared ingress
   carries two concerns, both keyed by the caller's client/connector id:
   - Provider webhooks — `https://webhooks.jsmunro.me/{provider}/{connectorId}`
     (e.g. `/github/github-app`); the provider HMAC (verified in the broker) is
     the authentication.
   - Discord interaction callbacks —
     `https://webhooks.jsmunro.me/{clientId}/interactions`; the Ed25519
     signature is the authentication, verified against the client's public key
     in the `DISCORD_INTERACTION_PUBLIC_KEYS` var (JSON `{clientId: hexPubKey}`).
     The worker binds workflows' `INTERACTION_SESSION` DO cross-script to kick
     the processor.

   The host is behind Cloudflare Access (service-token only), but the
   `/github/*`, `/stripe/*`, and `*/interactions` paths carry a Bypass=Everyone
   Access policy so providers and Discord can POST — the signature at the edge
   is the authentication there. All other paths require the `ragbot-webhooks`
   service token.
7. GitHub App connector: create the App, `GITHUB_APP_ID` var +
   `GITHUB_APP_PRIVATE_KEY` secret on the broker
   (`apps/connectors/workers/broker`).

## Configuration

- **AI config** is checked into `apps/bot/lib/ai/ai-config` (models, prompts,
  temperature, budgets per feature). The workflows worker reads each file
  from the `AI_CONFIG` KV first (keyed by basename) and falls back to the
  bundled copy, so an empty namespace or KV outage never bricks the bot.
  Values are memoized per isolate: publish a prompt change with
  `pnpm run config:push` (new isolates pick it up) or a redeploy.
- **AI usage limits** (`apps/bot/lib/domain/limits.ts`): per-user burst
  (`AI_BURST_LIMIT_PER_MINUTE`, default 8/min) and a global daily budget
  (`AI_GLOBAL_DAILY_BUDGET_USD`, default 10.00) across all AI ingresses.
  Spend truth is AI Gateway log cost, reconciled by the spend worker.
- **Guild allowlist**: `ALLOWED_GUILD_IDS` (comma-separated snowflakes) on the
  gateway and workflows configs; fails closed when set, allows-with-warning
  when unset.

## Operating it

- Health: every application worker serves `GET /health`; the gateway also
  serves `GET /` and `GET /.well-known/jwks.json` (the committed public
  keyring).
- Gateway websocket control: `POST /gateway/start`, `POST /gateway/stop`
  (kill switch — stays down until the next start), `GET /gateway/health`;
  all require `Authorization: Bearer $GATEWAY_CONTROL_TOKEN`.
- Every DLQ has a consumer that logs `dead_letter_message` (ids and envelope
  kinds only, never content) and acks, so dead letters surface in logs
  instead of accumulating.
- Smoke tests after a deploy: `POST /discord` PING → `{type:1}`; `/rag` +
  `/ragboard` in the guild; `/ask` creates a thread with an answer; a mention
  gets a reply; the dev-proxy runs `/ragboard` behind Access; a GitHub
  redelivery to the webhook URL → 200 (dedupe), tampered body → 401.
- `ragctl` (laptop CLI for the dev-proxy): `pnpm run ragctl -- login`, then
  `export RAGCTL_SESSION_COOKIE="better-auth.session_token=…"` (from a
  logged-in browser), then `pnpm run ragctl -- cmd ragboard`. State lives in
  `~/.config/ragctl` (0700).
