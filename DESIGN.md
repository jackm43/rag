# RAG Discord Bot Design

## Overview

`ragbot-worker` is a Cloudflare Worker that handles:
- Discord interaction webhooks for slash commands
- A Discord Gateway connection via Durable Objects
- AI response generation via Workers AI and Cloudflare Queues
- D1-backed persistence for rag events, totals, and roast history

User-facing slash commands:
- `/rag user:<discord-user>`
- `/ragboard`

Mention-driven AI behavior:
- If a user mentions the bot in a normal message, the gateway path enqueues an AI job and posts a generated reply to the channel.

## Architecture

Core components:
- Worker entrypoint: `src/index.ts`
- HTTP helpers and signature verification: `src/http.ts`
- Slash command handlers:
  - `src/commands/rag.ts`
  - `src/commands/ragboard.ts`
- Mention queue producer/consumer logic: `src/mention.ts`
- Gateway ingestion and connection lifecycle: `src/gateway.ts`
- Command registration script: `scripts/register-commands.ts`

Cloudflare bindings from `wrangler.jsonc`:
- `DB` (D1)
- `AI` (Workers AI)
- `DISCORD_GATEWAY` (Durable Object)
- `AI_JOBS` queue producer
- `ai-jobs` queue consumer with DLQ `ai-jobs-dlq`

## Request and Event Flows

### Public Route Boundary

```mermaid
flowchart LR
  Public[Public HTTP request] -->|GET /| Worker[Worker fetch handler]
  Worker -->|200 body: ok| Public

  Discord[Discord] -->|POST /: interaction JSON + signature headers| Worker
  Worker -->|JSON: Discord interaction callback| Discord

  Operator[Operator] -->|POST /gateway/start or GET /gateway/health + bot bearer token| Worker
  Worker -->|typed Durable Object RPC: start or health| DO[DiscordGateway Durable Object]
  DO -->|JSON: ok or health state| Worker
  Worker -->|JSON response| Operator

  Other[Anything else] -->|unconfigured path, including /admin/* and /oauth/*| Worker
  Worker -->|404 Not found| Other
```

### Slash Command Flow

```mermaid
sequenceDiagram
  participant Discord as Discord Interactions API
  participant Worker as Worker POST /
  participant Rag as rag command handler
  participant Board as ragboard handler
  participant DB as D1
  participant AI as AI Gateway / Workers AI

  Discord->>Worker: POST /: interaction JSON, x-signature-ed25519, x-signature-timestamp
  Worker->>Worker: Verify Ed25519 signature over timestamp + raw body
  Worker->>Worker: Route by interaction.data.name

  alt /rag
    Worker->>Rag: Interaction payload: target option, requester, token, application_id
    Rag-->>Discord: JSON: deferred channel message response
    Rag->>DB: INSERT rag_events: ragged user, reporter, created_at
    Rag->>DB: UPSERT rag_totals: ragged user and incremented count
    Rag->>DB: SELECT: total count, reporter count, recent rag_roasts
    Rag->>AI: Chat request: roast system prompt + target/reporter/counts
    AI-->>Rag: Generated roast text
    Rag->>DB: INSERT OR IGNORE rag_roasts: roast_text
    Rag->>Discord: PATCH webhook message: target mention, count, roast, allowed_mentions
  else /ragboard
    Worker->>Board: Interaction payload
    Board->>DB: SELECT top 10 rag_totals
    DB-->>Board: Rows: ragged_user_id, ragged_username, rag_count
    Board-->>Discord: JSON: leaderboard response text
  end
```

### Gateway Mention-to-AI Flow

```mermaid
sequenceDiagram
  participant Operator
  participant Worker as Worker /gateway/*
  participant DO as DiscordGateway Durable Object
  participant GW as Discord Gateway
  participant Queue as AI_JOBS / ai-jobs
  participant Consumer as Queue consumer
  participant REST as Discord REST API
  participant AI as AI Gateway / Workers AI
  participant DB as D1

  Operator->>Worker: POST /gateway/start: Authorization Bearer DISCORD_BOT_TOKEN
  Worker->>DO: start() Durable Object RPC after public bearer auth
  DO->>DO: Persist gatewayEnabled, set alarm
  DO->>GW: WebSocket IDENTIFY: bot token, intents
  GW-->>DO: READY + session metadata
  GW-->>DO: MESSAGE_CREATE: channel_id, message id, author, content, mentions, reply reference
  DO->>DO: Ignore unless author is not bot and content mentions this bot
  DO->>Queue: Send compact AiJob: channelId, messageId, botUserId, requester, prompt, reply ids
  Queue-->>Consumer: Deliver job body
  Consumer->>REST: GET channel history: before messageId, limit historyLimit
  REST-->>Consumer: Recent messages JSON
  Consumer->>REST: Optional GET replied-to message if missing from history
  REST-->>Consumer: Replied-to message JSON: author, content, attachments
  Consumer->>AI: Chat request: system prompt, normalized history, prompt, model settings
  AI-->>Consumer: AI response text + optional usage tokens
  Consumer->>DB: INSERT rag_ai_interactions: prompt, response, model, duration, status, usage
  Consumer->>REST: POST channel message: sanitized response, allowed_mentions parse=[]
  REST-->>Consumer: Message create response or error
  Consumer->>Queue: ack success/terminal errors, retry transient errors
```

## Command Behavior

### `/rag`

Inputs:
- required `user` option from Discord interaction data

Behavior:
- Validates target user option.
- Inserts event row into `rag_events`.
- Upserts total in `rag_totals` and increments `rag_count`.
- Reads current target total and reporter submission count.
- Reads recent roast history (`rag_roasts`) and generates a non-duplicate short roast using Workers AI.
- Falls back to deterministic roast lines if AI fails/duplicates/timeout.
- Stores roast line using `INSERT OR IGNORE`.
- Returns message with target mention, updated total, and roast.

### `/ragboard`

Behavior:
- Queries top 10 users from `rag_totals` ordered by count descending then user id.
- Returns ranked text leaderboard.
- Returns empty-state message if no data exists.

## Data Model

`rag_events`:
- immutable event stream of `/rag` submissions
- columns: `id`, `ragged_user_id`, `ragged_username`, `reported_by_user_id`, `reported_by_username`, `created_at`

`rag_totals`:
- aggregate materialization for fast leaderboard reads
- columns: `ragged_user_id` (PK), `ragged_username`, `rag_count`, `updated_at`

`rag_roasts`:
- dedupe memory for recent roast lines
- columns: `id`, `roast_text` (unique), `created_at`

## Security Model

- Interaction route enforces Discord Ed25519 signature verification.
- Invalid signatures return `401`.
- Gateway control endpoints use bearer token auth against the bot token before forwarding to the Durable Object.
- Any path not explicitly configured in the Worker route allowlist returns `404`.
- AI output is sanitized to remove mentions/IDs before posting.
- Channel posts include `allowed_mentions` restrictions.

## Operational Model

- `GET /` returns `ok` for basic health check.
- `GET /gateway/health` returns gateway connection status when called with the bot bearer token.
- Queue consumer processes one message at a time (`max_batch_size: 1`).
- Transient failures are retried with delay; terminal 4xx (except 429) are acknowledged to prevent poison retries.
