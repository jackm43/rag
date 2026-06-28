# ragbot-worker

Cloudflare Worker Discord bot for rag tracking, direct mention replies, and thread-based `/ask` conversations.

## Tech Stack

- Runtime: Cloudflare Workers (`src/index.ts`, `src/spend-worker.ts`)
- Language: TypeScript
- Database: Cloudflare D1 (`DB`)
- AI: Workers AI binding (`AI`) and AI Gateway REST; model and prompt config live in `src/ai-config` (`@cf/...` Workers AI models, Unified Billing partner chat models such as `grok/grok-4.3`, and web-search models such as `openai/gpt-4o-search-preview`)
- Queue: Cloudflare Queues (`AI_JOBS`, `ai-jobs`, `SPEND_JOBS`, `ai-spend-jobs`, dead-letter queues)
- Stateful connection: Durable Objects (`DiscordGateway`)
- Discord integration:
  - Interactions webhook
  - Discord REST calls for command registration, thread creation, and message posting
  - Gateway WebSocket for mention-based AI

## Command Surface

- Slash commands:
  - `/rag user:<discord-user>`
  - `/ragboard`
  - `/ragspend`
  - `/ragspendboard`
  - `/ask prompt:<question>`
  - `/bicture prompt:<image-prompt>`
  - `/ragjam prompt:<music-prompt> lyrics:<optional-song-lyrics>`
- HTTP endpoints:
  - `POST /discord` Discord interactions
  - `POST /gateway/start` start gateway connection (bot token auth)
  - `GET /gateway/health` gateway status (bot token auth)
- All other public paths, including `/` and source-file-looking paths, return `404`.

## Public Route Boundary

```mermaid
flowchart LR
  Discord[Discord Interactions] -->|POST /discord: signed interaction JSON| Worker
  Worker -->|200 JSON: interaction response| Discord

  Operator[Operator] -->|POST /gateway/start: Bearer DISCORD_BOT_TOKEN| Worker
  Operator -->|GET /gateway/health: Bearer DISCORD_BOT_TOKEN| Worker
  Worker -->|typed Durable Object RPC: start or health| GatewayDO[DiscordGateway Durable Object]
  GatewayDO -->|JSON: start result or health state| Worker
  Worker -->|JSON response| Operator

  Unknown[Other public request] -->|any unconfigured path or method| Worker
  Worker -->|404 Not found, or 405 on configured paths with the wrong method| Unknown
```

## Slash Command Flow

```mermaid
sequenceDiagram
  actor User as Discord user
  participant Discord as Discord Interactions API
  participant Worker as Cloudflare Worker POST /discord
  participant DB as D1 DB
  participant AI as AI Gateway / Workers AI

  User->>Discord: Slash command: /rag user, /ragboard, /ask prompt, /bicture prompt, or /ragjam prompt optional lyrics
  Discord->>Worker: POST /discord with interaction JSON + Ed25519 headers
  Worker->>Worker: Verify signature and route interaction.data.name

  alt /rag
    Worker->>Discord: Immediate JSON: deferred interaction response
    Worker->>DB: INSERT rag_events: target user, reporter, timestamp
    Worker->>DB: UPSERT rag_totals: increment target count
    Worker->>DB: SELECT rag total
    Worker->>Discord: PATCH original response: mention, total, allowed_mentions
  else /ragboard
    Worker->>DB: SELECT top rag_totals: user, count, updated_at
    DB-->>Worker: Leaderboard rows
    Worker-->>Discord: JSON interaction response: leaderboard text
  else /ragspend or /ragspendboard
    Worker->>DB: SELECT precomputed rag_ai_spend_totals
    DB-->>Worker: Personal spend or leaderboard rows
    Worker-->>Discord: JSON interaction response: spend text
  else /ask
    Worker->>Discord: Immediate JSON: deferred interaction response
    Worker->>AI: Chat request: concise thread title
    AI-->>Worker: Thread title
    Worker->>Discord: POST channel thread: title, public thread, 1 day archive
    Worker->>DB: UPSERT rag_ai_threads: thread id, prompt, requester, title
    Worker->>AI: Chat request or web-search Responses request: fresh user prompt
    AI-->>Worker: Chat response or cited research response
    Worker->>Discord: POST message inside created thread
    Worker->>Discord: PATCH original response with thread link
  else /bicture or /ragjam
    Worker->>Discord: Immediate JSON: deferred interaction response
    Worker->>AI: Unified Billing model request via Workers AI binding with AI Gateway metadata
    AI-->>Worker: Image data or audio URL
    Worker->>DB: INSERT pending AI spend event for Gateway log reconciliation
    Worker->>Discord: PATCH original response with generated media attachment or URL fallback
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
  Consumer->>Queue: Enqueue spend reconciliation job in ai-spend-jobs
  Queue-->>Consumer: Spend worker reads AI Gateway logs and updates rag_ai_spend_totals from raw cost
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
  - read updated target total
- AI usage: none
- Response:
  - target mention + updated rag total

### `/ragboard`

- Entry: interaction command routed in `src/index.ts`
- Handler: `src/commands/ragboard.ts`
- Data path:
  - select top 10 from `rag_totals` ordered by `rag_count`
- Response:
  - ranked leaderboard text or empty-state message

### `/ragspend`

- Entry: interaction command routed in `src/index.ts`
- Handler: `src/commands/ragspend.ts`
- Data path:
  - reads the invoking user's precomputed total from `rag_ai_spend_totals`
- Response:
  - `<@user> has spent $x.xx`

### `/ragspendboard`

- Entry: interaction command routed in `src/index.ts`
- Handler: `src/commands/ragspend.ts`
- Data path:
  - selects top 10 from `rag_ai_spend_totals` ordered by AI Gateway log cost
- Response:
  - ranked spend leaderboard text or empty-state message

### `/ask`

- Entry: interaction command routed in `src/index.ts`
- Handler: `src/commands/ask.ts`
- Behavior:
  - defers the interaction
  - generates a concise AI thread title
  - creates a public Discord thread in the current channel
  - stores the thread in `rag_ai_threads`
  - posts the sanitized AI response inside the thread
  - automatically uses neutral web-search research mode when the prompt asks for current information
  - edits the original interaction response with a thread link

### `/bicture`

- Entry: interaction command routed in `src/index.ts`
- Handler: `src/commands/bicture.ts`
- Behavior:
  - defers the interaction
  - sends the prompt to the configured Unified Billing image model through the Workers AI binding and AI Gateway
  - records a pending AI spend event tagged with AI Gateway metadata
  - edits the original interaction response with the generated image attachment

### `/ragjam`

- Entry: interaction command routed in `src/index.ts`
- Handler: `src/commands/ragjam.ts`
- Behavior:
  - defers the interaction
  - sends `prompt`, `is_instrumental: false`, optional `lyrics`, and `lyrics_optimizer` to `minimax/music-2.6`
  - sets `lyrics_optimizer: true` when lyrics are omitted so the model auto-generates lyrics from the prompt
  - uses the configured AI Gateway id on the Workers AI binding for Unified Billing and spend reconciliation metadata
  - records a pending AI spend event tagged with AI Gateway metadata
  - downloads the generated audio URL and edits the original interaction response with a Discord audio attachment
  - falls back to the generated song URL if the audio cannot be attached

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
- `ask-web-search.json` and `ask-web-search-system-prompt.md` control `/ask` research mode.
- `bicture-image.json` controls `/bicture` image generation.
- `ragjam-music.json` controls `/ragjam` music generation.
- AI spend uses raw AI Gateway log cost. Requests are tagged with metadata so the spend worker can reconcile the exact log entry.

## Local and Deploy Commands

`./deploy.sh`

`npm run dev:all` runs the Discord worker plus the spend worker locally.

`npm run deploy` deploys both workers. Use `npm run deploy:main` or `npm run deploy:spend` to deploy one worker.
