# ragbot-worker

Cloudflare Worker Discord bot for rag tracking and mention-triggered AI replies.

## Tech Stack

- Runtime: Cloudflare Workers (`src/index.ts`)
- Language: TypeScript
- Database: Cloudflare D1 (`DB`)
- AI: Workers AI binding (`AI`); model is runtime-configurable (`@cf/...` Workers AI models or partner models such as `xai/grok-4.3`), optionally routed through AI Gateway
- Queue: Cloudflare Queues (`AI_JOBS`, `ai-jobs`, `ai-jobs-dlq`)
- Stateful connection: Durable Objects (`DiscordGateway`)
- Admin auth: central auth gateway worker (`infra/applications/idp/worker`) that exchanges Cloudflare Access OIDC logins (GitHub IdP, authorization code + PKCE) for device-bound gateway sessions (DPoP, RFC 9449) and short-lived audience-scoped STS tokens (RFC 8693), with delegation-controlled identity chaining for service-to-service calls
- Service APIs: HTTP/OpenAPI under `/platform/<app>/v1/` (see `infra/applications/resources.yaml`)
- AI Gateway: `infra/applications/aigateway/worker` proxies chat completions to Cloudflare AI Gateway
- Web clients: `chat`, `console`, `portal` React apps with BFF workers (`createWebBffWorker`)
- Infrastructure: `infra/terraform` for Cloudflare Zero Trust, D1, queues; deploy with wrangler
- Discord integration:
  - Interactions webhook
  - REST API for command registration, message posting, and channel history
  - Gateway WebSocket for mention-based AI

## Command Surface

- Slash commands:
  - `/rag user:<discord-user>`
  - `/ragboard`
- HTTP endpoints:
  - `GET /` health
  - `POST /` Discord interactions
  - `POST /gateway/start` start gateway connection (bot token auth)
  - `GET /gateway/health` gateway status
  - Admin HTTP API: `/platform/ragbot/v1/*` (gateway JWT)

## End-to-End Flow Diagram

```mermaid
flowchart TD
  U[Discord User] -->|/rag or /ragboard| D1[Discord Interactions]
  D1 -->|POST /| W[Cloudflare Worker]
  W --> V[Ed25519 Signature Verify]
  V --> R{Command}

  R -->|rag| CR[handleDeferredRagCommand]
  CR --> DB1[(D1: rag_events)]
  CR --> DB2[(D1: rag_totals)]
  CR --> DB3[(D1: rag_roasts)]
  CR --> AI1[AI roast generation]
  AI1 --> CR
  CR --> DResp1[Discord Interaction Response]

  R -->|ragboard| CB[handleRagboardCommand]
  CB --> DB2
  CB --> DResp2[Discord Interaction Response]

  Admin[platy CLI] -->|authorization code + PKCE via GitHub IdP| CFA[Cloudflare Access OIDC]
  CFA -->|authorization code| Admin
  Admin -->|"POST /oauth/token authorization_code + DPoP proof"| GW[auth gateway worker]
  GW -->|device-bound session + rotating refresh token| Admin
  Admin -->|"POST /oauth/token token-exchange (RFC 8693) + DPoP"| GW
  GW -->|STS token aud=ragbot| Admin
  Admin -->|Connect-RPC + Bearer| AA[ragbot.v1 services]
  AA -->|verify via gateway JWKS| GW
  AA --> W
  AA --> DB4[(D1: rag_settings)]

  Admin2[Operator] -->|POST /gateway/start| W
  W --> DO[Durable Object DiscordGateway]
  DO -->|WebSocket| DG[Discord Gateway]
  DG -->|MESSAGE_CREATE mention| DO
  DO --> Q[(Queue: ai-jobs)]
  Q --> QC[Queue Consumer]
  QC --> H[Discord REST channel history]
  H --> QC
  QC --> AI2[AI chat completion]
  AI2 --> QC
  QC --> DR[Discord REST POST channel message]
```

## Command-by-Command Details

### `/rag`

- Entry: interaction command routed in `src/index.ts`
- Handler: `src/commands/rag.ts`
- Data path:
  - insert `rag_events` row
  - upsert/increment `rag_totals`
  - read recent `rag_roasts`
  - insert generated roast into `rag_roasts`
- AI usage:
  - one short roast line via the configured roast model
  - fallback roast templates on timeout/error/duplicate
- Response:
  - target mention + updated rag total + roast line

### `/ragboard`

- Entry: interaction command routed in `src/index.ts`
- Handler: `src/commands/ragboard.ts`
- Data path:
  - select top 10 from `rag_totals` ordered by `rag_count`
- Response:
  - ranked leaderboard text or empty-state message

### Mention-based AI (not a slash command)

- Entry:
  - `POST /gateway/start` starts Durable Object gateway client
  - gateway listens for Discord `MESSAGE_CREATE`
- Handlers: `src/gateway.ts` (connection) and `src/mention.ts` (logic)
- Queue and worker:
  - gateway enqueues the raw mention job in `AI_JOBS`
  - consumer fetches recent channel history and builds a chat conversation
  - generates a reply with the configured model, sanitizes mentions/IDs
- Delivery:
  - posts message with Discord REST API

## Auth Platform Layout

- `infra/applications/resources.yaml` HTTP route and scope catalog
- `infra/applications/<app>/service` and `web` HTTP client factories
- `infra/applications/idp/worker` auth gateway: OAuth, STS, registry, traces
- `infra/sdk/ts` worker SDK (`http/`, `auth/`, `client/`, `verify/`)
- `infra/sdk/web` browser DPoP session and BFF request helpers

## Configuration

Runtime config is stored in the D1 `rag_settings` table with code defaults in
`src/config.ts`. Manage it via the console web app or the ragbot HTTP API.
See `AGENTS.md` for the key list and terraform setup.

## Local and Deploy Commands

```bash
npm install
npm run dev
npm run deploy
```
