# Running With 1Password

## Required Secrets

Application and organization secrets live as `op://` references in the
manifests, not in a root `.env`. The CLI resolves them through the secret
service (`infra/cli/internal/secrets`) using the 1Password provider
(`OP_SERVICE_ACCOUNT_TOKEN` or desktop app via `OP_ACCOUNT`).

- `infra/applications/applications.yaml` — per-application worker secrets (e.g. ragbot Discord tokens)
- `infra/applications/organization.yaml` — organization secrets (e.g. `cloudflare_api_token` for bootstrap and deploy)

Local wrangler dev writes resolved values to `.dev.vars` via `platy dev vars`.
Deploy pushes resolved worker secrets with `wrangler secret bulk`.

## Current Runtime Shape

Six Cloudflare Workers (`auth-gateway`, `ragbot`, `aigateway`, `deploy`,
`cloudflare`, `chat`) plus a Go CLI, all speaking protobuf-first Connect-RPC
(Workers cannot terminate native gRPC, so services use the Connect protocol;
generated connect-go clients are wire compatible with gRPC semantics).

- `infra/applications/ragbot/worker/` ragbot worker (Discord bot)
 - `src/index.ts` routing: Discord webhook, gateway control, `ragbot.v1` Connect services
 - `src/services.ts` `ragbot.v1` service implementations (config, db, interactions, leaderboard, gateway control)
 - `src/http.ts` Discord webhook verification via the SDK `webhook` auth handler
 - `src/gateway.ts` `DiscordGateway` Durable Object (`DISCORD_GATEWAY` binding)
 - `src/mention.ts`, `src/ai.ts`, `src/config.ts`, `src/logger.ts` unchanged bot logic
- `infra/proto/` buf workspace: `idp/v1` (identity, token exchange, registry, discovery), `ragbot/v1`, `deploy/v1`
- `infra/applications/<app>/client|server|web|service` generated code: connect-go client, protobuf-es server, typed browser client (`web_client: true`), and typed worker-to-worker service client (`service_client: true`) whose factories wrap the SDK connector — each hop receives, validates, chains identity, attaches the token, and forwards (also exports the `proxyTarget` for BFF hops); regenerate with `platy dev generate [app...]` (or `npm run generate`)
- `infra/applications/idp/worker/` auth gateway worker `auth-gateway`
 - STS issuer: RFC 8693 token exchange at `POST /oauth/token`, ES256 JWTs (5 minute lifetime), signing keys rotated weekly in the `SigningKeys` Durable Object, JWKS at `/.well-known/jwks.json`
 - sessions: `POST /oauth/token` with `authorization_code` and `refresh_token` grants issues device-bound user sessions (DPoP, RFC 9449); `POST /oauth/revoke` revokes refresh tokens; access tokens carry `cnf.jkt` and `sid`, refresh tokens rotate on every use (reuse revokes the session and is audited), refresh lifetime 12 months; every refresh and every use of a `cnf`-bound token requires a fresh DPoP proof or the CLI falls back to the browser flow
 - registry: applications, resources/methods (scopes), delegations (which audiences/scopes an application may chain to), service clients (hashed secrets, only issued when none exist; rotate explicitly), audit log in its own D1 (`infra/applications/idp/worker/schema.sql`)
 - discovery: `GET /api/discovery` (issuer, full endpoint map including token/revocation/jwks/introspect endpoints, OIDC client metadata, registered applications with delegations)
 - trace store: `POST /v1/traces` ingests OTLP JSON from workers (authenticated with their service credential `Bearer <client_id>:<client_secret>`), 7-day retention in `idp_spans`; reads are a normal platform service — `idp.v1.TraceService` (`ListTraces`, `GetTrace`, server-streaming `StreamTraces` live tail) behind the standard protect policy, with generated Go/TS clients like any other RPC (`platy fetch idp.TraceService.ListTraces`)
 - client identities: `idp.v1.ClientIdentityService` (`RegisterClientIdentity`, `ListClientIdentities`) federates application sub-identities (e.g. one chat conversation) with the platform IdP — registered by the application acting for the user over a scoped delegation, stored in `idp_client_identities` (application, subject, key thumbprint), returning a gateway-signed ES256 identity token (`aud` = application, `sub` = user, `cnf.jkt` = the instance key, `act` = the registering chain)
 - subject tokens: Access OIDC access tokens, gateway STS tokens (chaining requires a service-credential actor token, recorded in the `act` claim and validated against the actor's registered delegations), or service credentials
 - only `ALLOWED_EMAILS` (default `jack@jsmunro.me`) can authenticate as a user
- `infra/sdk/ts/` worker SDK, grouped by responsibility:
 - `src/verify/` token and proof verifiers (`verifyStsToken`, `verifyOidcToken`, `verifyDpopProof`/`createDpopProof`/`generateDpopKey` over Web Crypto, `verifySignedWebhook` for ed25519 platform webhooks such as Discord, shared JWKS cache)
 - `src/auth/` authenticators (`stsAuthenticator`, `oidcAuthenticator`, `anyAuthenticator`, `requireSenderConstraint`) and the `protect` policy middleware (per-method auth + scope enforcement, default scope `<app>/<Service>.<Method>`, automatic DPoP enforcement for `cnf`-bound tokens); `sessionProxy` is the confidential-web-client (BFF) pattern — validate the DPoP session at the edge, chain identity per target audience, inject the token on the forwarded request
 - **transitive-identity standard**: the `act` chain on every token is validated at both ends. The gateway re-validates the full inherited chain against its registry on every RFC 8693 token exchange (each hop's application must still hold a delegation covering the next hop), rejects raw OIDC access tokens as chained-exchange subjects, and caps chain depth at 8. Receivers re-validate independently: `stsAuthenticator` (and `sessionChainAuthenticator` for minted tokens) resolves each hop's application from its `svc_{app}_` client id and checks pairwise delegations against the gateway discovery document (`src/verify/delegations.ts`, TTL-cached, fail closed), so a token whose chain is no longer an expected delegation path is refused even though its signature is valid (`request_denied` with `reason: actor_chain`)
 - **identity-boundary standard**: every request that crosses an identity boundary is logged and traced. Inbound: `protect`/`sessionProxy` annotate the request span with the verified identity and log refusals (`request_unauthenticated`, `request_denied` with reason); streaming RPCs additionally log `stream_completed` with actor + full stream duration. Outbound: every identity change is logged at the maker — `exchangeToken` logs `identity_exchanged` / `identity_exchange_refused` (audience, subject type, actor client id — never secrets), covering `chainExchange`, `connectorToken`, `sessionChainAuthenticator`, and all token sources. The instrumentation lives in the SDK *transports*, not in generated or application code: generated service clients bind through `connectorServiceClient`/`connectorTransport` (boundary logging `rpc_client`/`rpc_client_failed`, trace propagation, redirect fix built in), generated web clients through `webTransport`/`gatewayTransport` (same, browser-side console), and the Go SDK's `client.Fetch`/`Session.exchangeToken` emit the identical events (`rpc_client`, `identity_exchanged`) with `sdk/trace` rooting traceparent on every outbound request — codegen output is thin factory bindings, so the standard cannot be skipped by hand-written glue. Client instances (chats, the live-trace follower) are registered identities whose `x-client-instance` is annotated on every span
 - `src/client/` standardized outbound client: `createClient({ endpoint, token, dpop, decorate })` returns a `fetch`-compatible function plus a Connect JSON `call`; `chainExchange` performs transitive identity chaining with the worker's `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` secrets; `ttlCache` is the one shared TTL token cache (connector, provider, and session-chain paths all use it). The connector pattern is internal to the generated bindings: `serviceConnection(env, { audience, endpoint, binding, scopes })` is the only per-worker glue — it returns the connection the generated service client factory (`infra/applications/<app>/service`) consumes; the per-caller client chains the caller's `identity.subjectToken` to the target audience and validates the minted token against the caller (fail closed) before the request leaves
 - `src/provider/` the provider-connector half: `providerApiClient` wraps an external provider API with per-method allowlisted requests, taking auth `{ mode: "oauth" }` (gateway `ExchangeProviderToken` exchanges the caller's identity for a short-lived delegated provider token over the application's confidential provider OAuth client) or `{ mode: "api_token", token, header? }` (static worker secret injected on the outbound fetch); both modes require the verified caller `Identity`, share `ttlCache`, and emit `rpc_client` boundary logs
 - `src/otel/` minimal tracing: `tracerFromEnv`/`createTracer`, `traceRpc` server-span wrapper for RPC workers, `traceHeaders()` outbound traceparent injection, `annotateSpan` (the `protect` middleware and `sessionProxy` stamp the verified identity — actor, chain, session, client instance — on the request span). Spans always log as structured lines and export to the gateway's trace store: workers use `gatewayTraceExporter` (OTLP JSON over the gateway service binding, authenticated with their service credential); the gateway sinks its own spans straight to D1. Generic OTLP export via `OTEL_EXPORTER_OTLP_ENDPOINT` still works
- `infra/sdk/go/` client SDK: Access PKCE browser login, device-bound gateway sessions (`sdk/dpop` ES256 device key stored through the secret service, DPoP proofs on every gateway request, automatic refresh with browser fallback), `sdk/client` standardized request client (resolves endpoints and method paths from discovery, acquires audience-scoped tokens), identity-scoped secret service (`secrets.Service.Application` / `secrets.Service.User` over pluggable 1Password and file providers), user auth tokens stored through the secret service file provider (`~/.config/platy/secrets`, 0600), local application discovery service (`~/.config/platy/applications/<app>.json`), automatic STS exchange per audience
- `infra/cli/` the `platy` CLI (module `jsmunro.me/platy/cli`)
- `infra/applications/deploy/worker/` deploy service worker `deploy`: `deploy.v1.DeployService` uploads worker bundles and lists scripts by calling the `cloudflare` application over chained identity (generated service client, subject = caller, actor = deploy); it holds no Cloudflare credential of any kind
- `infra/applications/cloudflare/worker/` provider-connector worker `cloudflare`: `cloudflare.v1` services proxy a per-method allowlist of Cloudflare API calls. Each handler passes the verified caller `Identity` to `providerApiClient` (`provider_auth: oauth`), which exchanges it at the gateway (`ExchangeProviderToken`) for a short-lived delegated provider token minted from the application's confidential provider OAuth client (provisioned during `platy app register` from `provider_api_scopes`, delivered to the gateway as the `PROVIDER_OAUTH_CLIENTS` secret). First use by a subject returns an `authorizeUrl`; `platy fetch` opens it, the gateway callback (JWT-signed `state`) stores the refresh-token grant, and subsequent calls mint silently. Registered `impersonatable: false`, `trust_zone: tier2`
- `infra/applications/aigateway/worker/` AI Gateway worker `aigateway`: `aigateway.v1.ChatService` (`Complete`, `StreamComplete`, `ListModels`) proxies chat completions to a Cloudflare AI Gateway's OpenAI-compatible endpoint. Unified billing (Cloudflare-managed provider credentials); the `cf-aig-authorization` token is the only secret (`CF_AIG_TOKEN`, an `op://` reference) and is injected on the outbound fetch. Registered with `impersonatable: false`; `ragbot` holds an `aigateway` delegation, and the CLI can call it with `--as <app>` impersonation. `src/connectors.ts` exposes other applications as model tools (MCP-style) over chained identity through the generated service client (`infra/applications/ragbot/service`): subject = user, actor = aigateway, audience = ragbot, delegation scoped to the method; bounded tool rounds in both `Complete` and `StreamComplete`, tool failures return structured errors
- `infra/sdk/web/` shared browser auth SDK (Module 3, own tsconfig with DOM lib, checked by `npm run check`): `TrustZoneWebAuth` (non-extractable ES256 DPoP key in IndexedDB, auto OIDC PKCE login with a gateway-side code exchange, 12-month rotating session, `isAuthenticated()`/`ensureAuthenticated()` page bootstrap with silent refresh and loop-guarded redirect, `needs_login` via `onSessionChange`) plus the `webTransport`/`webClient` factory that generated per-app clients bind through
- `infra/applications/chat/` browser chat client `chat` (served at `chat.jsmunro.me`, authenticated via the auth gateway TrustZoneWebAuth session): a React app (`app/App.tsx`, `app/main.tsx`, `app/DataPanel.tsx`) on the shared web SDK and the generated `infra/applications/aigateway/web` client, plus `worker/src/worker.ts` — the confidential web client (BFF). `chat` is a *registered application* (client-only: no proto, but a service credential and delegations to `aigateway` and read-only `ragbot` scopes); its worker uses the SDK's `sessionProxy` to validate the browser's DPoP-bound session at the edge, chain the user's identity into an audience token per target, and forward over service bindings (`run_worker_first` routes only the proxied API prefixes to the worker; all other paths serve assets, strict CSP via `public/_headers`). The browser stays a dumb public client; targets always re-validate the audience token. The Data & platform APIs panel beside the chat fetches read-only RPCs (ragbot leaderboard/config/interactions/health, aigateway model catalog) through the same proxy via `auth.call`, plus gateway views (`/api/traces`, trace detail by id, `/api/discovery` registrations) via `auth.gatewayGet`. The page supports multiple chats via the chat session SDK (`registerChatInstance` in `infra/sdk/web`): the page generates a non-extractable ES256 key per chat and registers it through the worker (`POST /client/chats`, session-authenticated); the worker, acting for the user over its `idp` delegation, calls `ClientIdentityService.RegisterClientIdentity` and returns the gateway-signed, key-bound identity document. Each chat is its own client factory instance; requests carry `x-client-instance` (+ `x-client-token`), so the BFF partitions chained tokens per chat and the instance id appears on spans. The Live traces panel (`LiveTraces.tsx`, via `gatewayClient` + `TraceService.StreamTraces`) renders spans in real time as requests happen. Gateway session paths (`/idp.v1.*`, `/api/*`) remain zone-routed to the auth gateway. Build with `npm run chat:build` (esbuild → `public/app.js`) before `platy deploy chat`

Routes on the ragbot worker:
- Discord interactions: `POST /`
- Gateway control: `POST /gateway/start` (bot token auth), `GET /gateway/health`
- Admin RPCs: `POST /ragbot.v1.<Service>/<Method>` requiring a gateway STS token with audience `ragbot`; mutations are logged with the authenticated identity

## Authentication Model

1. `platy` CLI discovers the gateway via `GET /api/discovery` (issuer, endpoint map, OIDC client metadata, applications).
2. User logs in with OIDC authorization code + PKCE against the Access for SaaS app (GitHub identity provider; policy allows only `jack@jsmunro.me`). The Access token is used once.
3. CLI generates a per-device ES256 key (stored via the secret service file provider) and calls `POST /oauth/token` with the authorization code, PKCE verifier, and a DPoP proof. The gateway returns a 5-minute access token bound to the key (`cnf.jkt`) and a rotating refresh token valid 12 months.
4. Every CLI command checks token expiry; expired access tokens are refreshed transparently via `POST /oauth/token` with the `refresh_token` grant, which requires a fresh DPoP proof and rotates the refresh token (reuse detection revokes the session). Without the device key the user must re-complete the browser flow.
5. CLI exchanges the session token at the gateway (with DPoP) for a short-lived STS token with the target application audience and scopes.
6. Application workers verify STS tokens against the gateway JWKS (issuer + audience + per-method scope), and independently re-validate the token's `act` chain against the delegations published in gateway discovery (fail closed); a structurally valid token whose chain is not an expected delegation path is refused.
7. Transitive identity chaining: an application presents the caller's STS token as subject plus its own service credential as actor (`chainExchange` in the TS SDK, credentials delivered as worker secrets by `platy deploy`); the gateway requires a gateway-issued JWT subject, re-validates the full inherited actor chain against its registry, caps depth at 8, and the issued token carries the full chain in the `act` claim.
8. Provider API access is user-delegated through the gateway: a provider-connector application (e.g. `cloudflare`) calls `idp.v1.IdentityService/ExchangeProviderToken` with the caller's identity; the gateway redeems the subject's stored OAuth grant against the application's confidential provider OAuth client and returns a short-lived provider token scoped to that application's `provider_api_scopes`. No long-lived provider credential ever reaches a worker or the CLI.

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
over the app endpoint with STS auth). When a provider-connector method
responds with `provider authorization required`, `platy fetch` opens the
returned authorize URL and retries once the grant is stored:

```bash
go build -o platy jsmunro.me/platy/cli
./platy login
./platy introspect
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
- OAuth Clients Write (used by `platy app register` to provision per-application confidential provider OAuth clients for `provider_auth: oauth` applications)

Create or edit the token at https://dash.cloudflare.com/profile/api-tokens, then:

Bootstrap also creates public bypass Access applications for
`auth-gateway.<subdomain>.workers.dev` and `deploy.<subdomain>.workers.dev`.
That is required when the account has `deny_unmatched_requests` enabled (error 1050
on unprotected workers.dev hostnames). `ragbot-worker` already had a bypass app;
the gateway and deploy workers need the same treatment.

`platy deploy` reconciles zone routes after each worker deploy: any route still naming the worker but absent from its wrangler config is deleted and logged (wrangler itself never removes routes). All workers serve on custom domains only (`workers_dev: false` everywhere):
`auth-gateway.jsmunro.me`, `aigateway.jsmunro.me`, `ragbot.jsmunro.me`,
`deploy.jsmunro.me`, `chat.jsmunro.me` — endpoints map one-to-one to
applications in `applications.yaml`. The Discord interactions endpoint points
at `https://ragbot.jsmunro.me/`.

```bash
./platy bootstrap
```

Bootstrap resolves the Cloudflare API token from `--cf-api-token`,
`CLOUDFLARE_API_TOKEN`, or `organization.secrets.cloudflare_api_token`. It
finds the GitHub identity provider, creates the `Auth Gateway` Access for SaaS
OIDC application (PKCE public client, refresh tokens, policy allowing only
`jack@jsmunro.me`), prints the values for `infra/applications/idp/worker/wrangler.jsonc` vars
(`ACCESS_TEAM_DOMAIN`, `ACCESS_OIDC_CLIENT_ID`), and writes the same JSON to
`infra/applications/client_metadata.json`. Pass
`--team-id`, `--team-name`, and/or `--team-domain` when the token can access
multiple Zero Trust organizations; when only one identifier is given, bootstrap
resolves the rest from the Cloudflare API. Account id is resolved from the
token automatically.

## Application Registration and Codegen

Applications are declared in `infra/applications/applications.yaml` (name,
description, endpoint, worker name, wrangler config path, secret provider,
delegations, post-deploy hooks, `impersonatable` — default true; set false for
target-only services so registration skips the Cloudflare Access app — and the
provider-connector fields: `provider_auth: oauth` with `provider_api_scopes`
provisions a confidential provider OAuth client during registration and pushes
the gateway's `PROVIDER_OAUTH_CLIENTS` secret on register/sync, while
`provider_auth: api_token` declares that a static `op://` secret from the
application's secrets map is injected on outbound provider calls).

Adding a new application:

1. Define protos in `infra/proto/<app>/v1/` and add the manifest entry
   (endpoint, worker, config; delegations for any application it will chain
   into; `provider_auth` + `provider_api_scopes` if it proxies an external
   provider; `service_client: true`/`web_client: true` for typed callers).
2. `./platy app register <app>` — registers audience/resources/scopes/
   delegations, issues the service credential into 1Password, provisions the
   provider OAuth client when `provider_auth: oauth`, and generates code.
3. Implement the worker: generated handlers from
   `infra/applications/<app>/server` behind `protect` (with `stsAuthenticator`
   pointed at the gateway service binding), `traceRpc` +
   `gatewayTraceExporter` for the boundary standard, `serviceConnection` +
   generated service clients for outbound hops, `providerApiClient` for
   provider calls.
4. `./platy deploy <app>` — resolves secrets, deploys, pushes
   `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET`, reconciles zone routes.
5. `./platy fetch <app>.<Service>.<Method>` to verify end to end.

Then for registration alone:

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
`platy dev generate <app>` (protobuf via `infra/scripts/generate.sh`, plus
the browser client when `web_client: true`). `platy app plan` retrieves the
registry's current state and prints a field-level diff against the manifest
(endpoint, resources, delegations, access, trust boundary) without applying
anything; `platy app sync` uses the same diff to skip unchanged applications
and only re-register what changed. `platy app sync --prune` deletes gateway
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
perform delegated identity chaining with `chainExchange`.

## Setup and Run Commands

Install dependencies:

```bash
npm install
```

Create D1 databases (copy the generated ids into the wrangler configs):

```bash
npx wrangler d1 create ragbot
npx wrangler d1 create rag-auth-gateway
```

Apply D1 schemas locally:

```bash
npm run d1:migrate:local
npm run gw:d1:migrate:local
```

Create queues:

```bash
npx wrangler queues create ai-jobs
npx wrangler queues create ai-jobs-dlq
```

Register slash commands:

```bash
npm run register:commands
```

Run local dev servers:

```bash
npm run dev
npm run gw:dev
npm run deploysvc:dev
```

Typecheck and test:

```bash
npm run check
npm test
go vet jsmunro.me/platy/cli/... jsmunro.me/platy/sdk/... jsmunro.me/platy/applications/...
go build jsmunro.me/platy/cli/... jsmunro.me/platy/sdk/... jsmunro.me/platy/applications/...
```

Deploy workers (resolves manifest `op://` references through the 1Password SDK,
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
