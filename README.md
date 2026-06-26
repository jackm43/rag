# ragbot-worker

Cloudflare Worker Discord bot for rag tracking, direct mention replies, and thread-based `/ask` conversations.

## Tech Stack

- Runtime: Cloudflare Workers (`src/index.ts`)
- Language: TypeScript
- Database: Cloudflare D1 (`DB`)
- AI: Workers AI binding (`AI`); model and prompt config live in `src/ai-config` (`@cf/...` Workers AI models or Unified Billing partner models such as `grok/grok-4.3`), routed through AI Gateway with binding options when a gateway id is configured
- Queue: Cloudflare Queues (`AI_JOBS`, `ai-jobs`, `ai-jobs-dlq`)
- Stateful connection: Durable Objects (`DiscordGateway`)
- Discord integration:
  - Interactions webhook
  - Discord REST calls for command registration, thread creation, and message posting
  - Gateway WebSocket for mention-based AI

## Command Surface

- Slash commands:
  - `/rag user:<discord-user>`
  - `/ragboard`
  - `/ask prompt:<question>`
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

  User->>Discord: Slash command: /rag user, /ragboard, or /ask prompt
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
  else /ask
    Worker->>Discord: Immediate JSON: deferred interaction response
    Worker->>AI: Chat request: concise thread title
    AI-->>Worker: Thread title
    Worker->>Discord: POST channel thread: title, public thread, 1 day archive
    Worker->>DB: UPSERT rag_ai_threads: thread id, prompt, requester, title
    Worker->>AI: Chat request: fresh user prompt
    AI-->>Worker: Chat response
    Worker->>Discord: POST message inside created thread
    Worker->>Discord: PATCH original response with thread link
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

  User->>DiscordGateway: Parent channel message mentioning bot
  DiscordGateway-->>GatewayDO: MESSAGE_CREATE payload: author, channel_id, content, mentions
  GatewayDO->>Queue: Enqueue channel_reply AiJob: channel, source message, requester, prompt, reply ids
  Queue-->>Consumer: Deliver AiJob batch
  Consumer->>DiscordREST: Optional GET explicit replied-to message
  DiscordREST-->>Consumer: Replied-to message JSON: author, content, attachments
  Consumer->>AI: Chat request: fresh user prompt
  AI-->>Consumer: Chat response: generated text + optional usage
  Consumer->>DB: INSERT rag_ai_interactions: prompt, response, model, status, token usage
  Consumer->>DiscordREST: POST channel message: sanitized content, allowed_mentions parse=[]
  DiscordREST-->>Consumer: Created message JSON or API error
  Consumer->>Queue: ack on success/terminal 4xx, retry on transient errors

  User->>DiscordGateway: Later message inside tracked thread, no @ required
  DiscordGateway-->>GatewayDO: MESSAGE_CREATE payload for thread channel
  GatewayDO->>DB: SELECT rag_ai_threads by thread id
  GatewayDO->>Queue: Enqueue thread_reply AiJob
  Consumer->>DiscordREST: GET thread messages before messageId, limit historyLimit
  Consumer->>AI: Chat request: stored initial prompt + thread history + current message
  Consumer->>DiscordREST: POST thread message
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

### `/ask`

- Entry: interaction command routed in `src/index.ts`
- Handler: `src/commands/ask.ts`
- Behavior:
  - defers the interaction
  - generates a concise AI thread title
  - creates a public Discord thread in the current channel
  - stores the thread in `rag_ai_threads`
  - posts the sanitized AI response inside the thread
  - edits the original interaction response with a thread link

### Mention-based AI (not a slash command)

- Entry:
  - authenticated `POST /gateway/start` starts Durable Object gateway client
  - gateway listens for Discord `MESSAGE_CREATE`
- Handlers: `src/gateway.ts` (connection) and `src/mention.ts` (logic)
- Queue and worker:
  - parent-channel mentions enqueue a `channel_reply` job in `AI_JOBS`
  - channel reply jobs answer in the same Discord channel and do not create or record a thread
  - `/ask` creates a Discord thread, records it in `rag_ai_threads`, and posts the answer inside that thread
  - later messages in a tracked thread enqueue `thread_reply` jobs automatically without requiring an @ mention
  - reply jobs build context from the stored initial prompt plus recent messages in that thread only
  - generated replies are sanitized for mentions/IDs
- Delivery:
  - direct mentions post in the same Discord channel
  - `/ask` and tracked-thread follow-ups post inside the Discord thread

## Configuration

AI config is checked into `src/ai-config`:

- `discord-response.json` and `discord-response-system-prompt.md` control mention replies.
- `rag-roast.json` and `rag-roast-system-prompt.md` control `/rag` roast generation.

## Local and Deploy Commands

`./deploy.sh`
