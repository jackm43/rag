# Running With 1Password

## Required Secrets

This project expects these environment variables:
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`

`.env` is set to 1Password references (`op://...`), so run project commands through `op run`.

## Current Runtime Shape

- Cloudflare Worker entrypoints:
  - `workers/public/gateway/src/index.ts` Discord routing, gateway controls (edge zone)
  - `workers/services/brain/src/index.ts` AI job queue consumer (application zone)
  - `workers/services/responder/src/index.ts` Discord write egress: outbox consumer + `Responder` RPC entrypoint (application zone)
  - `workers/services/spend/src/index.ts` AI spend aggregation queue consumer (application zone)
- Trust zones: Untrusted (public) -> Edge (gateway) -> Applications (brain, responder, spend) -> Trusted (service registry, signing roots)
- Modules:
  - `packages/auth` centralised auth service client library: RFC-named identity vocabulary (`MachinePrincipal`, `Subject`, delegation chain, `Target`, `TrustZone`), `serviceClients(env)`/`createServiceClient` factory (Cedar exchange check, signing keys, token minting, transport, denial logging), `createServiceServer` receive pipeline yielding `ServiceRequest` (verified `RequestContext` + payload), service manifests and registry client
  - `packages/contracts/service.capnp` transport-layer contract for the service boundary: `ServiceMessage` (queue hop body: envelope bytes + JWS token), `ServiceManifest`/`ManifestSnapshot` (registry RPC payloads); generated code via `npm run contracts:build`. The identity token itself stays a JWS (RFC 7515), carried as Text
  - `packages/authz` Cedar engine: `authorize()` (`Human`/`Machine` principals, static + registry entities), `authorizeAndForward` forwarding authorizer, policies in `packages/authz/policies/*.cedar` (`commands`, `operator`, `services`)
  - `packages/identity` Ed25519 identity-context tokens (RFC 8693-style mint/verify), committed public keyring
  - `packages/boundaries/inbound` untrusted-zone ingress guards (Discord signature, operator bearer token)
  - `packages/boundaries/outbound` egress boundary clients (host allowlists, credentials, timeouts)
  - `packages/domain/http.ts` Discord signature verification, JSON responses, constant-time compare
  - `packages/discord/index.ts` Discord REST helpers
  - `workers/public/gateway/src/gateway.ts` `DiscordGateway` Durable Object (`DISCORD_GATEWAY` binding)
  - `workers/public/gateway/src/registry.ts` `ServiceRegistry` Durable Object (`SERVICE_REGISTRY` binding on every worker); workers register manifests on startup and the Cedar authorizer consumes the entity snapshot
  - `workers/public/gateway/openapi.yaml` OpenAPI spec for the gateway's public routes — the source of truth the gateway router is CONSTRUCTED from: `npm run routes:build` generates `src/routes.ts`, and `src/router.ts` wires paths, methods, security schemes (ingress guards) and operationId handlers from it. Only the gateway speaks HTTP; everything else is worker RPC/queues carrying Cap'n Proto
  - `packages/domain/mention.ts` mention handling, thread tracking, AI title generation, and AI queue consumer (thread conversation context)
  - `packages/domain/commands/ask.ts` `/ask` thread creation, normal AI response handling, and web-search research mode
  - `packages/domain/commands/ragspend.ts` `/ragspend` personal AI spend lookup and `/ragspendboard` spend leaderboard
  - `packages/ai/ai.ts` model-agnostic chat calls through the Workers AI binding (`env.AI.run`) or AI Gateway REST. Workers AI `@cf/...` models use binding options (`gateway: { id }`), Unified Billing partner chat models use AI Gateway compat chat completions, and `/ask` research mode uses an OpenAI search model such as `openai/gpt-4o-search-preview` via AI Gateway.
  - `packages/ai/spend.ts` raw spend event recording, AI Gateway log cost reconciliation, spend queue consumer helper, and dollar formatting
  - `packages/ai/config.ts` loads source-controlled AI config from `packages/ai/ai-config`
  - `packages/logger/index.ts` structured logging
- Discord interactions route: `POST /discord`
- Gateway control routes: `POST /gateway/start`, `GET /gateway/health` (both require `Authorization: Bearer $DISCORD_BOT_TOKEN`)
- Public routes are allowlisted. Any path not listed here returns `404`.
- Database: D1 (`DB` binding) using `schema.sql`
- AI model binding: `AI`
- Queue bindings:
 - producer: `AI_JOBS` -> `ai-jobs`
 - producer: `SPEND_JOBS` -> `ai-spend-jobs`
 - consumer: `ai-jobs` with dead-letter queue `ai-jobs-dlq`
 - spend worker consumer: `ai-spend-jobs` with dead-letter queue `ai-spend-jobs-dlq`

## Runtime Configuration

AI config lives in `packages/ai/ai-config`:
- `discord-response.json`: mention and `/ask` response model, max tokens, temperature, thread history limit, AI Gateway id used by the AI binding
- `discord-response-system-prompt.md`: mention response system prompt
- `ask-web-search.json`: `/ask` web-search model, max output tokens, temperature, search turns, search context size, AI Gateway id used by the AI binding
- `ask-web-search-system-prompt.md`: neutral `/ask` web research system prompt
- AI Gateway log cost is the source of truth for spend. AI requests include metadata for exact cost reconciliation.

## Setup and Run Commands

Install dependencies:

```bash
op run --env-file=.env -- npm install
```

Create D1 database:

```bash
op run --env-file=.env -- npx wrangler d1 create ragbot
```

Copy the generated id into `workers/public/gateway/wrangler.jsonc`:
- `database_id`

Do not point `preview_database_id` at the production database; create a separate preview DB if preview deployments are ever used.

Apply D1 schema locally:

```bash
op run --env-file=.env -- npm run d1:migrate:local
```

Create queues:

```bash
op run --env-file=.env -- npx wrangler queues create ai-jobs
op run --env-file=.env -- npx wrangler queues create ai-jobs-dlq
op run --env-file=.env -- npx wrangler queues create ai-spend-jobs
op run --env-file=.env -- npx wrangler queues create ai-spend-jobs-dlq
```

Register slash commands:

```bash
op run --env-file=.env -- npm run register:commands
```

Run local Worker dev server:

```bash
op run --env-file=.env -- npm run dev
```

Run local Worker dev server with both worker configs:

```bash
op run --env-file=.env -- npm run dev:all
```

Typecheck and test:

```bash
npm run check
npm test
```

Deploy Worker:

```bash
op run --env-file=.env -- npm run deploy
```

Start Gateway connection (after deploy):

```bash
op run --env-file=.env -- sh -c 'curl -X POST "https://ragbot-worker.jsmunro.workers.dev/gateway/start" -H "Authorization: Bearer $DISCORD_BOT_TOKEN"'
```

Or run the helper:

```bash
./deploy.sh
```

## Discord App Configuration

Bot scopes:
- `bot`
- `applications.commands`

Bot permissions:
- `Send Messages`
- `Create Public Threads`
- `Send Messages in Threads`
- `Use Slash Commands`
- `Read Message History` (required for thread conversation context)

Use the deployed Worker URL plus `/discord` as the Discord interactions endpoint.
