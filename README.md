# ragbot-worker

Cloudflare Worker Discord bot for rag tracking and mention-triggered AI replies.

## Tech Stack

- Runtime: Cloudflare Workers (`src/index.ts`)
- Language: TypeScript
- Database: Cloudflare D1 (`DB`)
- AI: Workers AI binding (`AI`); model and prompt config live in `src/ai-config` (`@cf/...` Workers AI models or Unified Billing partner models such as `grok/grok-4.3`), routed through AI Gateway with binding options when a gateway id is configured
- Queue: Cloudflare Queues (`AI_JOBS`, `ai-jobs`, `ai-jobs-dlq`)
- Stateful connection: Durable Objects (`DiscordGateway`)
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
  - `GET /gateway/health` gateway status (bot token auth)
- All other public paths return `404`.

## Public Route Boundary

```mermaid
flowchart LR
  Client[Public HTTP client] -->|GET /| Worker[Cloudflare Worker]
  Worker -->|200 text/plain: ok| Client

  Discord[Discord Interactions] -->|POST /: signed interaction JSON| Worker
  Worker -->|200 JSON: interaction response| Discord

  Operator[Operator] -->|POST /gateway/start: Bearer DISCORD_BOT_TOKEN| Worker
  Operator -->|GET /gateway/health: Bearer DISCORD_BOT_TOKEN| Worker
  Worker -->|typed Durable Object RPC: start or health| GatewayDO[DiscordGateway Durable Object]
  GatewayDO -->|JSON: start result or health state| Worker
  Worker -->|JSON response| Operator

  Unknown[Other public request] -->|any unconfigured path or method| Worker
  Worker -->|404 Not found, or 405 on / non-POST| Unknown
```

## Slash Command Flow

```mermaid
sequenceDiagram
  actor User as Discord user
  participant Discord as Discord Interactions API
  participant Worker as Cloudflare Worker POST /
  participant DB as D1 DB
  participant AI as AI Gateway / Workers AI

  User->>Discord: Slash command: /rag user or /ragboard
  Discord->>Worker: POST / with interaction JSON + Ed25519 headers
  Worker->>Worker: Verify signature and route interaction.data.name

  alt /rag
    Worker->>Discord: Immediate JSON: deferred interaction response
    Worker->>DB: INSERT rag_events: target user, reporter, timestamp
    Worker->>DB: UPSERT rag_totals: increment target count
    Worker->>DB: SELECT rag total, reporter count, recent roast text
    Worker->>AI: Chat request: roast prompt, model, max_tokens, temperature
    AI-->>Worker: Chat response: roast line + optional usage
    Worker->>DB: INSERT OR IGNORE rag_roasts: generated line
    Worker->>Discord: PATCH original response: mention, total, roast, allowed_mentions
  else /ragboard
    Worker->>DB: SELECT top rag_totals: user, count, updated_at
    DB-->>Worker: Leaderboard rows
    Worker-->>Discord: JSON interaction response: leaderboard text
  end
```

## Gateway Mention Flow

```mermaid
sequenceDiagram
  actor Operator
  actor User as Discord user
  participant Worker as Cloudflare Worker
  participant GatewayDO as DiscordGateway Durable Object
  participant DiscordGateway as Discord Gateway WebSocket
  participant Queue as Cloudflare Queue ai-jobs
  participant Consumer as Queue consumer
  participant DiscordREST as Discord REST API
  participant AI as AI Gateway / Workers AI
  participant DB as D1 DB

  Operator->>Worker: POST /gateway/start with Authorization: Bearer bot token
  Worker->>GatewayDO: start() Durable Object RPC
  GatewayDO->>GatewayDO: Store gatewayEnabled=true and set watchdog alarm
  GatewayDO->>DiscordGateway: WebSocket IDENTIFY/RESUME with bot token and intents
  DiscordGateway-->>GatewayDO: READY, heartbeat ACKs, MESSAGE_CREATE events

  User->>DiscordGateway: Channel message mentioning bot
  DiscordGateway-->>GatewayDO: MESSAGE_CREATE payload: author, channel_id, content, mentions
  GatewayDO->>Queue: Enqueue compact AiJob: channelId, messageId, botUserId, requester, prompt, reply ids
  Queue-->>Consumer: Deliver AiJob batch
  Consumer->>DiscordREST: GET channel messages: before messageId, limit historyLimit
  DiscordREST-->>Consumer: Message history JSON: users, bot replies, content
  Consumer->>DiscordREST: Optional GET replied-to message if not already in history
  DiscordREST-->>Consumer: Replied-to message JSON: author, content, attachments
  Consumer->>AI: Chat request: system prompt + channel context + user prompt
  AI-->>Consumer: Chat response: generated text + optional usage
  Consumer->>DB: INSERT rag_ai_interactions: prompt, response, model, status, token usage
  Consumer->>DiscordREST: POST channel message: sanitized content, allowed_mentions parse=[]
  DiscordREST-->>Consumer: Created message JSON or API error
  Consumer->>Queue: ack on success/terminal 4xx, retry on transient errors
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
  - authenticated `POST /gateway/start` starts Durable Object gateway client
  - gateway listens for Discord `MESSAGE_CREATE`
- Handlers: `src/gateway.ts` (connection) and `src/mention.ts` (logic)
- Queue and worker:
  - gateway enqueues a compact mention job in `AI_JOBS` with IDs, requester, and prompt
  - consumer fetches recent channel history and any missing replied-to message context, then builds a chat conversation
  - generates a reply with the configured model, sanitizes mentions/IDs
- Delivery:
  - posts message with Discord REST API

## Configuration

AI config is checked into `src/ai-config`:

- `discord-response.json` and `discord-response-system-prompt.md` control mention replies.
- `rag-roast.json` and `rag-roast-system-prompt.md` control `/rag` roast generation.

## Local and Deploy Commands

`./deploy.sh`
