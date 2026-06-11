# Running With 1Password

## Required Secrets

This project expects these environment variables:
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`
- `CLOUDFLARE_API_TOKEN` (bootstrap only)
- `CLOUDFLARE_ACCOUNT_ID`

`.env` is set to 1Password references (`op://...`), so run project commands through `op run`.

## Current Runtime Shape

Three Cloudflare Workers plus a Go CLI, all speaking protobuf-first Connect-RPC
(Workers cannot terminate native gRPC, so services use the Connect protocol;
generated connect-go clients are wire compatible with gRPC semantics).

- `src/` ragbot worker (Discord bot)
 - `src/index.ts` routing: Discord webhook, gateway control, `ragbot.v1` Connect services
 - `src/services.ts` `ragbot.v1` service implementations (config, db, interactions, leaderboard, gateway control)
 - `src/http.ts` Discord webhook verification via the SDK `webhook` auth handler
 - `src/gateway.ts` `DiscordGateway` Durable Object (`DISCORD_GATEWAY` binding)
 - `src/mention.ts`, `src/ai.ts`, `src/config.ts`, `src/logger.ts` unchanged bot logic
- `infra/proto/` buf workspace: `idp/v1` (identity, token exchange, registry, discovery), `ragbot/v1`, `deploy/v1`
- `infra/applications/<app>/client|server` generated code (connect-go client, protobuf-es server); regenerate with `infra/scripts/generate.sh [app...]`
- `infra/gateway/` auth gateway worker `auth-gateway`
 - STS issuer: RFC 8693 token exchange at `idp.v1.IdentityService/ExchangeToken`, ES256 JWTs (5 minute lifetime), signing keys rotated weekly in the `SigningKeys` Durable Object, JWKS at `/.well-known/jwks.json`
 - sessions: `CreateSession`/`RefreshSession`/`RevokeSession` issue device-bound user sessions (DPoP, RFC 9449); access tokens carry `cnf.jkt` and `sid`, refresh tokens rotate on every use (reuse revokes the session and is audited), refresh lifetime 12 months; every refresh and every use of a `cnf`-bound token requires a fresh DPoP proof or the CLI falls back to the browser flow
 - registry: applications, resources/methods (scopes), delegations (which audiences/scopes an application may chain to), service clients (hashed secrets, only issued when none exist; rotate explicitly), audit log in its own D1 (`infra/gateway/schema.sql`)
 - discovery: `GET /api/discovery` (issuer, full endpoint map including session/exchange/jwks/whoami endpoints, OIDC client metadata, registered applications with delegations)
 - subject tokens: Access OIDC access tokens, gateway STS tokens (chaining requires a service-credential actor token, recorded in the `act` claim and validated against the actor's registered delegations), or service credentials
 - only `ALLOWED_EMAILS` (default `jack@jsmunro.me`) can authenticate as a user
- `infra/sdk/ts/` worker SDK, grouped by responsibility:
 - `src/verify/` token and proof verifiers (`verifyStsToken`, `verifyOidcToken`, `verifyDpopProof`/`createDpopProof`/`generateDpopKey` over Web Crypto, `verifySignedWebhook` for ed25519 platform webhooks such as Discord, shared JWKS cache)
 - `src/auth/` authenticators (`stsAuthenticator`, `oidcAuthenticator`, `anyAuthenticator`, `requireSenderConstraint`) and the `protect` policy middleware (per-method auth + scope enforcement, default scope `<app>/<Service>.<Method>`, automatic DPoP enforcement for `cnf`-bound tokens)
 - `src/client/` standardized outbound client: `createClient({ endpoint, token, dpop, decorate })` returns a `fetch`-compatible function plus a Connect JSON `call`, with token sources `serviceTokenSource` (authenticate as the service) and `chainedTokenSource`/`chainExchange` (transitive identity chaining with the worker's `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` secrets); the same client works in workers, browsers, and node
- `infra/sdk/go/` client SDK: Access PKCE browser login, device-bound gateway sessions (`sdk/dpop` ES256 device key stored through the secret service, DPoP proofs on every gateway request, automatic refresh with browser fallback), `sdk/client` standardized request client (resolves endpoints and method paths from discovery, acquires audience-scoped tokens, applies per-application decorators), identity-scoped secret service (`secrets.Service.Application` / `secrets.Service.User` over pluggable 1Password and file providers), user auth tokens stored through the secret service file provider (`~/.config/platy/secrets`, 0600), local application discovery service (`~/.config/platy/applications/<app>.json`), automatic STS exchange per audience, Cloudflare delegated OAuth flow
- `infra/cli/` the `platy` CLI (module `jsmunro.me/platy/cli`)
- `infra/deploy/` deploy service worker `deploy`: `deploy.v1.DeployService` uploads worker bundles and lists scripts using the caller's delegated Cloudflare OAuth token from the `X-Delegated-Cloudflare-Token` header (no stored Cloudflare secret)

Routes on the ragbot worker:
- Discord interactions: `POST /`
- Gateway control: `POST /gateway/start` (bot token auth), `GET /gateway/health`
- Admin RPCs: `POST /ragbot.v1.<Service>/<Method>` requiring a gateway STS token with audience `ragbot`; mutations are logged with the authenticated identity

## Authentication Model

1. `platy` CLI discovers the gateway via `GET /api/discovery` (issuer, endpoint map, OIDC client metadata, applications).
2. User logs in with OIDC authorization code + PKCE against the Access for SaaS app (GitHub identity provider; policy allows only `jack@jsmunro.me`). The Access token is used once.
3. CLI generates a per-device ES256 key (stored via the secret service file provider) and calls `CreateSession` with the Access token plus a DPoP proof. The gateway returns a 5-minute access token bound to the key (`cnf.jkt`) and a rotating refresh token valid 12 months.
4. Every CLI command checks token expiry; expired access tokens are refreshed transparently via `RefreshSession`, which requires a fresh DPoP proof and rotates the refresh token (reuse detection revokes the session). Without the device key the user must re-complete the browser flow.
5. CLI exchanges the session token at the gateway (with DPoP) for a short-lived STS token with the target application audience and scopes.
6. Application workers verify STS tokens against the gateway JWKS (issuer + audience + per-method scope).
7. Transitive identity chaining: an application presents the caller's STS token as subject plus its own service credential as actor (`chainedTokenSource`/`chainExchange` in the TS SDK, credentials delivered as worker secrets by `platy deploy`); the gateway validates the target audience and scopes against the actor's registered delegations from `applications.yaml`, and the issued token carries the full actor chain in the `act` claim.
8. Cloudflare API access is user-delegated: the CLI runs the Cloudflare OAuth flow (`platy cloudflare login`) against the self-managed OAuth client created by bootstrap, and the deploy service forwards that short-lived token to the Cloudflare API.

## Runtime Configuration

Config lives in the D1 `rag_settings` table; defaults are in `src/config.ts`. Keys:
- `ai_response_model` (e.g. `@cf/meta/llama-3.1-8b-instruct` or `xai/grok-4.3`)
- `ai_roast_model`
- `ai_system_prompt`
- `ai_roast_system_prompt`
- `ai_max_tokens`
- `ai_temperature`
- `ai_history_limit` (channel messages used as conversation context)
- `ai_gateway_id` (optional AI Gateway id; when set, all `env.AI.run` calls route through it)

Manage config with the CLI. Application access is generic: `platy discover`
refreshes local metadata documents, `platy metadata [app]` lists callable
methods as `<app>.<Service>.<Method>` lines, and `platy fetch` invokes any
registered method through the SDK request client (`sdk/client`: Connect JSON
over the app endpoint with STS auth; the deploy app additionally gets the
delegated Cloudflare token header via a per-app request decorator registered
in `infra/cli/internal/platform/platform.go`):

```bash
go build -o platy jsmunro.me/platy/cli
./platy login
./platy whoami
./platy discover
./platy metadata ragbot
./platy fetch ragbot --help
./platy fetch ragbot.ConfigService.ListConfig
./platy fetch ragbot.ConfigService.UpdateConfig -d '{"key":"ai_response_model","value":"xai/grok-4.3"}'
./platy fetch ragbot.DatabaseService.Query -d '{"sql":"SELECT * FROM rag_totals LIMIT 5"}'
./platy fetch ragbot.InteractionService.ListInteractions -d '{"limit":10}'
./platy fetch ragbot.LeaderboardService.ListTotals -d '{"limit":25}'
./platy fetch ragbot.GatewayControlService.GetHealth
./platy fetch deploy.DeployService.ListWorkers
./platy logout
```

Override the gateway URL with `PLATY_GATEWAY_URL`.

## Bootstrap (replaces Terraform)

One-time setup with an API token that includes at least:
- Access: Apps and Policies Write (creates the Access for SaaS OIDC app and email policy)
- Account Read (resolves the Cloudflare account from the token)
- OAuth Clients Write (creates the `platy` Cloudflare OAuth client; without this permission the Access app step still succeeds but OAuth client creation returns 403)

Create or edit the token at https://dash.cloudflare.com/profile/api-tokens, then:

Bootstrap also creates public bypass Access applications for
`auth-gateway.<subdomain>.workers.dev` and `deploy.<subdomain>.workers.dev`.
That is required when the account has `deny_unmatched_requests` enabled (error 1050
on unprotected workers.dev hostnames). `ragbot-worker` already had a bypass app;
the gateway and deploy workers need the same treatment.

```bash
op run --env-file=.env -- ./platy bootstrap
```

This finds the GitHub identity provider, creates the `Auth Gateway` Access
for SaaS OIDC application (PKCE public client, refresh tokens, policy allowing
only `jack@jsmunro.me`), creates the `platy` Cloudflare OAuth client, and
prints the values for `infra/gateway/wrangler.jsonc` vars
(`ACCESS_TEAM_DOMAIN`, `ACCESS_OIDC_CLIENT_ID`) and the
`CF_OAUTH_CLIENT_ID` environment variable, and writes the same JSON to
`infra/applications/client_metadata.json`. Pass `--team-id`, `--team-name`, and/or
`--team-domain` when the token can access multiple Zero Trust organizations; when
only one identifier is given, bootstrap resolves the rest from the Cloudflare API.
Account id is resolved from the token automatically.

## Application Registration and Codegen

Applications are declared in `infra/applications/applications.yaml` (name,
description, endpoint, worker name, wrangler config path, language, secret
provider, delegations, webhooks, post-deploy hooks). Define protos in
`infra/proto/<app>/v1/`, add the manifest entry, then:

```bash
./platy app register <app>     # one application (flags override manifest values)
./platy app sync [--prune]     # reconcile every manifest application with the gateway
```

This validates the protos, registers the application (audience, resources,
method scopes, delegations) in the gateway registry, issues a service
credential only when the application has none (use `platy app rotate-client`
to rotate), generates code into `infra/applications/<app>/client` (Go) and
`infra/applications/<app>/server` (TypeScript), and writes the application
metadata document (audience, endpoint, resources, scopes, credential
reference) to both `~/.config/platy/applications/<app>.json` and
`infra/applications/<app>/metadata.json`. Codegen alone:
`infra/scripts/generate.sh <app>`. `platy app sync --prune` deletes gateway
applications that are no longer in the manifest.

The issued client secret is never printed. It is stored through the SDK
secret service (`infra/sdk/go/secrets`) via
`Service.Application.StoreServiceClientCredential` using the 1Password
provider, which writes an item titled `<app>` with a `client_secret` field
into the Services vault (`mqrwrig24fxs3ssywmf3pxwqgy`). The provider
authenticates with `OP_SERVICE_ACCOUNT_TOKEN` when set, otherwise it falls
back to the 1Password desktop app integration using `OP_ACCOUNT`. The CLI
registers a local application discovery document at
`~/.config/platy/applications/<app>.json` (the `ApplicationDiscoveryService` in
`infra/sdk/go/discovery`) containing the registry metadata (audience,
endpoint, resources, scopes) plus the credential (`client_id`, `op://` secret
reference, provider). Resolve the secret back with
`Service.Application.ResolveServiceClientCredential`. The CLI prefers local
documents for endpoint and audience lookups and falls back to gateway
discovery; `platy discover` refreshes the local documents from the gateway
while preserving stored credentials. `platy app rotate-client` updates the
1Password item and the local document in place, and `platy app delete` removes
the local document.

Register the existing applications after deploying their workers:

```bash
./platy app sync
```

`platy deploy` pushes each registered application's service credential to its
worker as `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` secrets so workers can
perform delegated identity chaining with `chainedTokenSource`/`chainExchange`.

## Setup and Run Commands

Install dependencies:

```bash
op run --env-file=.env -- npm install
```

Create D1 databases (copy the generated ids into the wrangler configs):

```bash
op run --env-file=.env -- npx wrangler d1 create ragbot
op run --env-file=.env -- npx wrangler d1 create rag-auth-gateway
```

Apply D1 schemas locally:

```bash
op run --env-file=.env -- npm run d1:migrate:local
op run --env-file=.env -- npm run gw:d1:migrate:local
```

Create queues:

```bash
op run --env-file=.env -- npx wrangler queues create ai-jobs
op run --env-file=.env -- npx wrangler queues create ai-jobs-dlq
```

Register slash commands:

```bash
op run --env-file=.env -- npm run register:commands
```

Run local dev servers:

```bash
op run --env-file=.env -- npm run dev
op run --env-file=.env -- npm run gw:dev
op run --env-file=.env -- npm run deploysvc:dev
```

Typecheck and test:

```bash
npm run check
npm test
go vet jsmunro.me/platy/cli/... jsmunro.me/platy/sdk/... jsmunro.me/platy/applications/...
go build jsmunro.me/platy/cli/... jsmunro.me/platy/sdk/... jsmunro.me/platy/applications/...
```

Deploy workers (resolves `.env` `op://` references through the 1Password SDK,
syncs bootstrap metadata into the gateway wrangler vars, deploys every worker
in `infra/applications/applications.yaml`, pushes service credentials as
worker secrets, and runs post-deploy hooks such as starting the Discord
gateway):

```bash
go build -o platy jsmunro.me/platy/cli
./platy deploy            # everything
./platy deploy ragbot     # one application
```

## Hardening Phase (planned)

Attach the workers to `jsmunro.me` hostnames, enable API Shield mTLS, issue
zone managed-CA client certificates from the gateway, and verify
`cf.tlsClientAuth` in the SDK as an additional `mtls` auth handler.

## Discord App Configuration

Bot scopes:
- `bot`
- `applications.commands`

Bot permissions:
- `Send Messages`
- `Use Slash Commands`
- `Read Message History` (required for mention conversation context)

Use the deployed Worker URL as the Discord interactions endpoint.
