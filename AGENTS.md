# Running With 1Password

## Required Secrets

Application and organization secrets live as `op://` references in the
manifests, not in a root `.env`. Resolve them with the 1Password CLI
(`op read`, `op inject`, `op run`) or the desktop app via `OP_ACCOUNT`.

- `infra/applications/applications.yaml` — per-application worker secrets (e.g. ragbot Discord tokens)
- `infra/applications/organization.yaml` — organization secrets (e.g. `cloudflare_api_token` for deploy and provider OAuth provisioning)

Local wrangler dev uses `.dev.vars` (write resolved secrets there manually or via `op inject`).
Deploy pushes resolved worker secrets with `wrangler secret bulk`.

## Current Runtime Shape

TypeScript-only platform on Cloudflare Workers with HTTP/OpenAPI APIs under
`/platform/<app>/v1/`. Scope strings like `ragbot/ConfigService.ListConfig`
remain the auth/delegation vocabulary; routes and methods are declared in
`infra/applications/resources.yaml`.

- `infra/applications/ragbot/worker/` Discord bot plus admin HTTP API (`http-api.ts`, `http-services.ts`)
- `infra/applications/idp/worker/` auth gateway (`auth-gateway`): OAuth, STS, registry, traces, client identities
- `infra/applications/<app>/service` and `web` — hand-written HTTP client factories for worker and browser callers
- `infra/sdk/ts/src/http/` — Hono HTTP app framework (`createHttpApp`, envelope, auth, OpenAPI)
- `infra/sdk/web/` — browser DPoP session (`BrowserAuth.request`) for web apps and BFF proxies
- BFF web apps (`chat`, `console`, `portal`): static `worker/src/worker.ts` using `createWebBffWorker`, wrangler `run_worker_first` on `/platform/*/v1/*` and `/client/*`

Routes on the ragbot worker:
- Discord interactions: `POST /`
- Gateway control: `POST /gateway/start` (bot token auth), `GET /gateway/health`
- Admin HTTP API: `/platform/ragbot/v1/*` (gateway JWT + per-method scopes)

## Authentication Model

1. Browser clients discover the gateway via `GET /api/discovery`.
2. User logs in with OIDC authorization code + PKCE against the Access for SaaS app (GitHub IdP; policy allows only `jack@jsmunro.me`).
3. The browser holds a device-bound DPoP session (ES256 key in IndexedDB, rotating refresh token).
4. BFF workers validate the session, chain identity per target audience, and forward over service bindings.
5. Application workers verify STS tokens against gateway JWKS (issuer + audience + scope) and re-validate the `act` chain against discovery delegations (fail closed).
6. Transitive identity chaining uses `chainExchange` / `connectorToken` with `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` worker secrets.
7. Provider API access is user-delegated through `ExchangeProviderToken` at the gateway.

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

Manage config through the console web app or `PATCH /platform/ragbot/v1/configurations/{key}` with a gateway token.

Override the gateway URL in browser apps via discovery; workers use `AUTH_GATEWAY_URL` in wrangler vars.

## Static Infrastructure (Terraform)

All static Cloudflare configuration lives in `infra/terraform` (provider v5):
Zero Trust organization settings (MFA, gateway TLS/inspection, device
settings), the `admins` Access group, the WARP posture rule, all reusable
Access policies (Platform admins, device posture, workers.dev bypass, the
tier0-tier3 trust zone policies, the enroll policies), the `Auth Gateway`
Access for SaaS OIDC application (PKCE public client, refresh tokens),
per-application `platy-impersonate-<app>` SaaS apps, workers.dev bypass apps
(`auth-gateway`, `deploy`, `cloudflare`), web-client bypass apps for
client-only applications (`chat`, `console`), the `Platy Enroll` app, the D1
databases, and the queues. The configuration derives application sets from
`infra/applications/applications.yaml` and trust zone policy inputs from
`infra/applications/organization.yaml`, so manifest changes flow into the next
apply. Existing resources were adopted with `import` blocks in
`infra/terraform/imports.tf`.

Apply with an API token that includes at least Access: Apps and Policies
Write, Account Read, D1 Write, Queues Write, Zero Trust Write, and OAuth
Clients Write (the last is used by `platy app register`, not Terraform).
Create or edit the token at https://dash.cloudflare.com/profile/api-tokens,
then:

```bash
CLOUDFLARE_API_TOKEN=$(op read "op://Services/Cloudflare User API Token/password") \
  terraform -chdir=infra/terraform apply
```

The apply also writes two gitignored metadata files consumed by the CLI:
`infra/applications/provider_config.json` (trust boundary, identity providers,
groups, posture, impersonation Access client ids per application, provisioned
trust zone policy ids) and `infra/applications/client_metadata.json`
(`wrangler_vars` with `ACCESS_TEAM_DOMAIN`/`ACCESS_OIDC_CLIENT_ID`, synced
into `infra/applications/idp/worker/wrangler.jsonc` by `platy deploy`).
`platy app register` reads impersonation client ids from the provider config
instead of calling the Cloudflare API; adding an impersonatable application
requires a terraform apply first. `platy manage provider sync` uploads the
provider config to the gateway registry.

The CLI keeps only the post-deployment, dynamic Cloudflare surface: the
per-application confidential provider OAuth clients (creation during
`platy app register`, rotation via `platy app rotate-provider-oauth` — secret
capture and 1Password delivery do not fit Terraform), worker deploys and
secret pushes through wrangler, and stale zone route deletion.

The workers.dev bypass Access applications are required when the account has
`deny_unmatched_requests` enabled (error 1050 on unprotected workers.dev
hostnames).

`platy deploy` reconciles zone routes after each worker deploy: any route still naming the worker but absent from its wrangler config is deleted and logged (wrangler itself never removes routes). All workers serve on custom domains only (`workers_dev: false` everywhere):
`auth-gateway.jsmunro.me`, `aigateway.jsmunro.me`, `ragbot.jsmunro.me`,
`deploy.jsmunro.me`, `chat.jsmunro.me` — endpoints map one-to-one to
applications in `applications.yaml`. The Discord interactions endpoint points
at `https://ragbot.jsmunro.me/`.

## Application Registration and Codegen

Applications are declared in `infra/applications/applications.yaml` (name,
description, endpoint, worker name, wrangler config path, secret provider,
delegations, post-deploy hooks, `impersonatable` — default true; set false for
target-only services so no impersonation Access app is expected (Terraform
derives the impersonation app set from the same flag) — and the
provider-connector fields: `provider_auth: oauth` with `provider_api_scopes`
provisions a confidential provider OAuth client during registration and pushes
the gateway's `PROVIDER_OAUTH_CLIENTS` secret on register/sync, while
`provider_auth: api_token` declares that a static `op://` secret from the
application's secrets map is injected on outbound provider calls).

Adding a new application:

1. Add HTTP routes to `infra/applications/resources.yaml` and the manifest entry in `applications.yaml`.
2. `terraform -chdir=infra/terraform apply` for Access apps and provider config metadata.
3. Register the application in the gateway registry (HTTP registry API) and issue a service credential into 1Password.
4. Implement the worker with `http-api.ts` / `http-services.ts` behind `platformAuthenticator`.
5. `wrangler deploy` with secrets via `wrangler secret bulk`.
6. For client-only web apps, add a static BFF `worker/src/worker.ts` and wrangler `run_worker_first` routes for `/platform/*/v1/*`.

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
```

Deploy workers with wrangler (resolve `op://` secrets into `.dev.vars` or push with `wrangler secret bulk`):

```bash
npm run deploy
npm run gw:deploy
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
