# Running With 1Password

## Required Secrets

This project expects these environment variables:
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`

`.env` is set to 1Password references (`op://...`), so run project commands through `op run`.

## Current Runtime Shape

- Applications live at `workers/applications/<id>/{web, api/middleware_client, service_server}`:
  `gateway` (`ragbot-worker`; Discord ingress, `DiscordGateway` DO, `DevProxy`
  and `ApplicationMiddleware` entrypoints, `/.well-known/jwks.json` serving the
  committed Ed25519 keyring), `registry` (control-plane DOs +
  `REGISTRY_SERVICE` self-binding), `attest` (thin middleware -> signed
  `attest.invoke` envelope -> `ATTEST_SERVICE` self-binding entrypoint;
  business logic lives in `service_server/src/{operations,webhook}.ts`),
  `metadata` (`METADATA_SERVICE`), `webhooks`, `dev-proxy`.
- Services live at `workers/services/<id>` (no public route, no web/api
  split): `workflows` (AI job queue consumer), `responder` (Discord write
  egress: outbox consumer + `Responder` RPC entrypoint), `spend` (AI spend
  aggregation queue consumer), `connectors` (the credential broker), `egress`
  (the generic outbound-HTTP sidecar).
- Trust zones (`packages/auth/principal.ts`): `platform` (public ingress +
  egress/provider-boundary workers: gateway, attest, dev-proxy, webhooks,
  egress), `application` (internal domain workers: workflows, responder,
  spend, metadata, connectors), `management` (admin surfaces over application
  resources), `control-plane` (infrastructure authority over runtime state and
  trust machinery: registry). The old untrusted->edge->application->trusted
  taxonomy is gone.
- Egress: all outbound HTTP for discord-rest, discord-webhook, cloudflare-api,
  media-download, and ai-gateway flows through the `egress` service worker as
  signed `egress.request` hops, with bundled default profiles
  (`packages/egress/profiles.ts`) so a fresh deploy works before any
  `EgressControl` DO seeding (DO-stored profiles override the defaults).
  `DISCORD_BOT_TOKEN`, `CF_AIG_TOKEN`, and `CLOUDFLARE_API_TOKEN` now live only
  on the egress worker — the sole exception is the gateway's `DiscordGateway`
  DO, which still holds `DISCORD_BOT_TOKEN` for the websocket `IDENTIFY`.
  Deliberate exceptions that stay on the direct `packages/boundaries/outbound`
  client: the connectors broker's per-connector provider hosts (dynamic hosts)
  and the Vault secrets backend; the 1Password SDK does its own HTTP outside
  any boundary client.
- Modules:
  - `packages/auth` centralised auth service client library: RFC-named identity vocabulary (`MachinePrincipal`, `Subject`, delegation chain, `Target`, `TrustZone` = `platform`/`application`/`management`/`control-plane`), `serviceClients(env)`/`createServiceClient` factory (Cedar exchange check, signing keys, token minting, transport, denial logging), `createServiceServer` receive pipeline yielding `ServiceRequest` (verified `RequestContext` + payload), service manifests and registry client, the operation-registration gate, and the fail-closed placement control plane (an env with no working `SERVICE_REGISTRY` binding denies rather than passes through)
  - `packages/contracts/service.capnp` transport-layer contract for the service boundary: `ServiceMessage` (queue hop body: envelope bytes + JWS token), `ServiceManifest`/`ManifestSnapshot` (registry RPC payloads); generated code via `npm run contracts:build`. The identity token itself stays a JWS (RFC 7515), carried as Text
  - `packages/authz` Cedar engine: `authorize()` (`Human`/`Machine` principals, static + registry entities), `authorizeAndForward` forwarding authorizer, policies in `packages/authz/policies/*.cedar` (`commands`, `gateway`, `connectors`, `egress`, `services`)
  - `packages/identity` Ed25519 identity-context tokens (RFC 8693-style mint/verify), committed public keyring
  - `packages/boundaries/inbound` ingress guards (Discord signature, Cloudflare Access, operator bearer token) plus the shared Better Auth session module (`packages/boundaries/inbound/better-auth.ts`, used by both dev-proxy and registry middlewares)
  - `packages/boundaries/outbound` the now mostly-legacy-path direct egress boundary client (host allowlists, credentials, timeouts) — still used by the connectors broker's provider hosts and the Vault secrets backend; everything else routes through `packages/egress`
  - `packages/egress` the egress sidecar's bundled default profiles (`profiles.ts`) and client/server halves that carry outbound HTTP as signed `egress.request` hops
  - `packages/domain/http.ts` Discord signature verification, JSON responses, constant-time compare
  - `packages/discord/index.ts` Discord REST helpers
  - `workers/applications/gateway/service_server/src/gateway.ts` `DiscordGateway` Durable Object (`DISCORD_GATEWAY` binding)
  - `workers/applications/registry/service_server/src/registry.ts` `ServiceRegistry` Durable Object (`SERVICE_REGISTRY` binding on every worker); workers register manifests on startup and the Cedar authorizer consumes the entity snapshot
  - `workers/applications/gateway/api/middleware_client/src/application-bindings.ts` source of truth for the gateway's public routes and discovery docs — `npm run routes:build` generates `openapi.yaml`, `src/openapi.ts`, and `src/routes.ts`; `src/router.ts` wires paths, methods, security schemes (ingress guards) and operationId handlers from the generated route table.
  - `workers/applications/metadata/api/middleware_client/src/application-bindings.ts` source of truth for the metadata GraphQL app's public routes — `npm run routes:build` generates `openapi.yaml` and `src/openapi.ts`; the worker serves the generated document at `/openapi.json`.
  - `workers/applications/attest/api/middleware_client/src/application-bindings.ts` source of truth for the artifact-attestation webhook app's public routes — `npm run routes:build` generates `openapi.yaml` and `src/openapi.ts`; the worker serves the generated document at `/openapi.json`.
  - `workers/applications/registry/api/middleware_client/src/application-bindings.ts` source of truth for the registry app's public routes — `npm run routes:build` generates `openapi.yaml` and `src/openapi.ts`; the worker serves the generated document at `/openapi.json`.
  - `workers/applications/webhooks/api/middleware_client/src/application-bindings.ts` source of truth for the webhook-ingress app's public routes — `npm run routes:build` generates `openapi.yaml` and `src/openapi.ts`; the worker serves the generated document at `/openapi.json`.
  - `workers/applications/dev-proxy/api/middleware_client/src/application-bindings.ts` source of truth for the dev-proxy admin app's public routes — `npm run routes:build` generates `openapi.yaml` and `src/openapi.ts`; `npm run devproxy:types` regenerates `packages/devproxy-client/api-types.ts`; the worker serves the generated document at `/openapi.json`.
  - `packages/domain/mention.ts` mention handling, thread tracking, AI title generation, and AI queue consumer (thread conversation context)
  - `packages/domain/commands/ask.ts` `/ask` thread creation, normal AI response handling, and web-search research mode
  - `packages/domain/commands/ragspend.ts` `/ragspend` personal AI spend lookup and `/ragspendboard` spend leaderboard
  - `packages/inference/client.ts` the centralised model-access interface: owns the AI Gateway credential (`CF_AIG_TOKEN` boundary client), URL construction, and binding-vs-gateway routing. Workers AI `@cf/...` / `workers-ai/...` models run on the `env.AI` binding (gateway-wrapped when a gatewayId is set); Unified Billing partner chat models use AI Gateway compat chat completions. Nothing outside this package touches `env.AI` or `gateway.ai.cloudflare.com`.
  - `packages/ai/ai.ts` ragbot's chat workflows over `packages/inference`: config-derived request parameters and raw-payload interpretation (text/usage/sources extraction, mention sanitization). `/ask` research mode uses an OpenAI search model such as `openai/gpt-4o-search-preview` via the same seam.
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

Copy the generated id into `workers/applications/gateway/api/middleware_client/wrangler.jsonc`:
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
