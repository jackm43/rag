# Running With 1Password

## Required Secrets

This project expects these environment variables:
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`
- `CLIENT_ID`
- `CLIENT_SECRET`

`.env` is set to 1Password references (`op://...`), so run project commands through `op run`.

## Current Runtime Shape

- Cloudflare Worker entrypoint: `src/index.ts` (routing only)
- Modules:
  - `src/http.ts` Discord signature verification, JSON responses, constant-time compare
  - `src/discord.ts` Discord REST helpers
  - `src/gateway.ts` `DiscordGateway` Durable Object (`DISCORD_GATEWAY` binding)
  - `src/access.ts` OIDC token verification against the Access application JWKS
  - `src/mention.ts` mention handling and AI queue consumer (channel history context)
  - `src/ai.ts` model-agnostic chat calls (Workers AI `@cf/...` and partner models such as `xai/grok-4.3`), optional AI Gateway routing
  - `src/config.ts` runtime config stored in the D1 `rag_settings` table
  - `src/admin.ts` Cloudflare Access protected admin API
  - `src/logger.ts` structured logging
- Discord interactions route: `POST /`
- Gateway control routes: `POST /gateway/start` (bot token auth), `GET /gateway/health`
- OIDC client metadata: `GET /oauth/config` (public; issuer, client_id, endpoints)
- Admin API (fails closed; requires a bearer token issued by the Access for SaaS OIDC application):
  - `GET /admin/whoami`
  - `GET /admin/config`, `PUT /admin/config`, `DELETE /admin/config/:key`
  - `POST /admin/db` body `{sql, params?}`
  - `GET /admin/interactions?limit=`
  - `GET /admin/gateway/health`, `POST /admin/gateway/start`
  - mutations are audit-logged with the authenticated identity
- Database: D1 (`DB` binding) using `schema.sql`
- AI model binding: `AI`
- Queue bindings:
 - producer: `AI_JOBS` -> `ai-jobs`
 - consumer: `ai-jobs` with dead-letter queue `ai-jobs-dlq`

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

Manage config with the CLI:

```bash
npm run cli -- config list
npm run cli -- config set ai_response_model xai/grok-4.3
npm run cli -- db "SELECT * FROM rag_totals LIMIT 5"
npm run cli -- interactions 10
npm run cli -- gateway health
npm run cli -- whoami
npm run cli -- logout
```

CLI auth flow (override worker URL with `RAGBOT_URL`):
1. The CLI discovers the OIDC client metadata from `GET /oauth/config`.
2. It runs the OIDC authorization code flow with PKCE as a public client: it opens the browser to the Access authorization endpoint and receives the code on `http://127.0.0.1:8976/callback`.
3. Access issues access + refresh tokens; the CLI caches them with mode 0600 in `~/.config/ragbot/tokens.json` and refreshes automatically, falling back to a fresh browser login when the refresh token expires or is revoked.
4. Admin requests send `Authorization: Bearer <access token>`.

`ragbot login` forces a fresh browser login; `ragbot logout` drops cached tokens.

## Cloudflare Access Setup (admin API auth)

Access acts as the OIDC identity provider via an Access for SaaS application, managed with Terraform (`terraform/`, provider `cloudflare/cloudflare ~> 5.19`). Cloudflare issues, signs, stores, and revokes all tokens; revoking a user's Zero Trust session invalidates their refresh tokens.

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# edit account_id and allowed_emails, then (CLOUDFLARE_API_TOKEN must be in the op item)
op run --env-file=.env -- terraform -chdir=terraform init
op run --env-file=.env -- terraform -chdir=terraform apply
```

Then set in `wrangler.jsonc` vars and deploy:
1. `ACCESS_TEAM_DOMAIN`: `https://<team>.cloudflareaccess.com`
2. `ACCESS_OIDC_CLIENT_ID`: the `oidc_client_id` Terraform output

The Worker validates every bearer token against the application's JWKS endpoint (`/cdn-cgi/access/sso/oidc/<client_id>/jwks`) with issuer and audience checks, so the admin API is denied-by-default until both vars are set.

## Setup and Run Commands

Install dependencies:

```bash
op run --env-file=.env -- npm install
```

Create D1 database:

```bash
op run --env-file=.env -- npx wrangler d1 create ragbot
```

Copy generated IDs into `wrangler.jsonc`:
- `database_id`
- `preview_database_id`

Apply D1 schema locally:

```bash
op run --env-file=.env -- npm run d1:migrate:local
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

Run local Worker dev server:

```bash
op run --env-file=.env -- npm run dev
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
- `Use Slash Commands`
- `Read Message History` (required for mention conversation context)

Use the deployed Worker URL as the Discord interactions endpoint.
