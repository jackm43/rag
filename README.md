# ragbot-worker

Cloudflare Worker Discord bot for rag tracking and mention-triggered AI replies.

## Tech Stack

- Runtime: Cloudflare Workers (`src/index.ts`)
- Language: TypeScript
- Database: Cloudflare D1 (`DB`)
- AI: Workers AI binding (`AI`); model and prompt config live in `src/ai-config` (`@cf/...` Workers AI models or Unified Billing partner models such as `grok/grok-4.3`), routed through AI Gateway with binding options when a gateway id is configured
- Queue: Cloudflare Queues (`AI_JOBS`, `ai-jobs`, `ai-jobs-dlq`)
- Stateful connection: Durable Objects (`DiscordGateway`)
- Admin auth: Cloudflare Access for SaaS as OIDC identity provider (authorization code + PKCE, Cloudflare-managed refresh tokens)
- Infrastructure: Terraform for the Access OIDC application and policy (`terraform/`)
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
  - `GET /oauth/config` public OIDC client metadata for the CLI
  - `/admin/*` admin API (config, db, interactions, gateway, whoami); requires an Access-issued OIDC bearer token
- CLI (`npm run cli`): config management, db queries, interaction logs, gateway control; authenticates with OIDC authorization code + PKCE against Cloudflare Access

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

  Admin[Operator CLI] -->|authorization code + PKCE| CFA[Cloudflare Access OIDC]
  CFA -->|access + refresh tokens| Admin
  Admin -->|Bearer access token| AA[/admin API/]
  AA -->|verify via app JWKS| CFA
  AA --> W
  AA --> DB4[(D1: data tables)]

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

## Configuration

AI config is checked into `src/ai-config`:

- `discord-response.json` and `discord-response-system-prompt.md` control mention replies.
- `rag-roast.json` and `rag-roast-system-prompt.md` control `/rag` roast generation.

The admin API and CLI can still report the active AI config, but mutations are
rejected because AI behavior is source-controlled.

## Local and Deploy Commands

`./deploy.sh`
