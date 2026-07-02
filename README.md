# ragbot-worker

Cloudflare Worker Discord bot for rag tracking, direct mention replies, and thread-based `/ask` conversations.

## Tech Stack

- Runtime: Cloudflare Workers (`workers/public/gateway/src/index.ts`, `workers/services/brain/src/index.ts`, `workers/services/responder/src/index.ts`, `workers/services/spend/src/index.ts`)
- Language: TypeScript
- Database: Cloudflare D1 (`DB`)
- AI: Workers AI binding (`AI`) and AI Gateway REST; model and prompt config live in `packages/ai/ai-config` (`@cf/...` Workers AI models, Unified Billing partner chat models such as `grok/grok-4.3`, and web-search models such as `openai/gpt-4o-search-preview`)
- Queue: Cloudflare Queues (`AI_JOBS`, `ai-jobs`, `DISCORD_OUTBOX`, `discord-outbox`, `SPEND_JOBS`, `ai-spend-jobs`, dead-letter queues)
- Queue contracts: Cap'n Proto event envelopes (`packages/contracts`) via `capnp-es`; every queue message is encoded and value-validated at the producer and re-validated at the consumer (snowflake id shape, free-text length caps). The generated `packages/contracts/envelope.ts` is committed; regenerate after schema changes with `npm run contracts:build`, which needs the native `capnp` compiler (`brew install capnp`)
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
  - `POST /gateway/start` start gateway connection (`GATEWAY_CONTROL_TOKEN` auth)
  - `GET /gateway/health` gateway status (`GATEWAY_CONTROL_TOKEN` auth)
- All other public paths, including `/` and source-file-looking paths, return `404`.

## Public Route Boundary

```mermaid
flowchart LR
  Discord[Discord Interactions] -->|POST /discord: signed interaction JSON| Worker
  Worker -->|200 JSON: interaction response| Discord

  Operator[Operator] -->|POST /gateway/start: Bearer GATEWAY_CONTROL_TOKEN| Worker
  Operator -->|GET /gateway/health: Bearer GATEWAY_CONTROL_TOKEN| Worker
  Worker -->|typed Durable Object RPC: start or health| GatewayDO[DiscordGateway Durable Object]
  GatewayDO -->|JSON: start result or health state| Worker
  Worker -->|JSON response| Operator

  Unknown[Other public request] -->|any unconfigured path or method| Worker
  Worker -->|404 Not found, or 405 on configured paths with the wrong method| Unknown
```

The gateway control endpoints authenticate with a dedicated `GATEWAY_CONTROL_TOKEN` secret, never the Discord bot token, and fail closed with `401` when the secret is not configured. Operators must create it before use: set it on the worker with `wrangler secret put GATEWAY_CONTROL_TOKEN` and add a matching `GATEWAY_CONTROL_TOKEN` field to the 1Password `ragbot` item referenced by `.env` so `deploy.sh` can send it.

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
    Worker->>DB: Batch: INSERT rag_events + UPSERT rag_totals RETURNING rag_count
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
    Worker->>Discord: POST channel thread: prompt-derived title (no model call), public thread, 1 day archive
    Worker->>DB: UPSERT rag_ai_threads: thread id, prompt, requester, title
    Worker->>Worker: Enqueue encoded ask job in ai-jobs
    Worker->>Discord: PATCH original response with thread link immediately
    Note over Worker,AI: queue consumer answers asynchronously
    Worker->>AI: Chat request or web-search request: fresh user prompt
    AI-->>Worker: Chat response or cited research response
    Worker->>Discord: POST answer inside created thread
  else /bicture or /ragjam
    Worker->>Discord: Immediate JSON: deferred interaction response
    Worker->>Worker: Enqueue encoded bicture or ragjam job in ai-jobs
    Note over Worker,AI: queue consumer generates the media asynchronously
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
  participant Consumer as Brain worker queue consumer
  participant Outbox as Cloudflare Queue discord-outbox
  participant Responder as Responder worker
  participant DiscordREST as Discord REST API
  participant AI as AI Gateway / Workers AI
  participant DB as D1 DB

  Operator->>Worker: POST /gateway/start with Authorization: Bearer GATEWAY_CONTROL_TOKEN
  Worker->>GatewayDO: start() Durable Object RPC
  GatewayDO->>GatewayDO: Store gatewayEnabled=true and set watchdog alarm
  GatewayDO->>DiscordGateway: WebSocket IDENTIFY/RESUME with bot token and intents
  DiscordGateway-->>GatewayDO: READY, heartbeat ACKs, MESSAGE_CREATE events

  User->>DiscordGateway: Parent channel message mentioning bot
  DiscordGateway-->>GatewayDO: MESSAGE_CREATE payload: author, channel_id, content, mentions
  GatewayDO->>Queue: Enqueue encoded message.received event: ids, capped content, author, mentions, reply ids (no D1, no REST)
  Queue-->>Consumer: Deliver event batch
  Consumer->>DB: SELECT rag_ai_threads by channel id (thread tracking lives brain-side)
  Consumer->>DiscordREST: Optional GET bot role ids when roles are mentioned
  Consumer->>DB: Rate limit + budget pre-flight; denial notices go out via the outbox
  Consumer->>DiscordREST: Optional GET explicit replied-to message
  DiscordREST-->>Consumer: Replied-to message JSON: author, content, attachments
  Consumer->>AI: Chat request: fresh user prompt
  AI-->>Consumer: Chat response: generated text + optional usage
  Consumer->>DB: INSERT rag_ai_interactions: prompt, sanitized response, model, status, token usage
  Consumer->>Queue: Enqueue spend reconciliation job in ai-spend-jobs
  Queue-->>Consumer: Spend worker reads AI Gateway logs and updates rag_ai_spend_totals from raw cost
  Consumer->>Outbox: Enqueue encoded reply.channel_message with raw model text
  Outbox-->>Responder: Deliver reply batch
  Responder->>DiscordREST: POST channel message: sanitized content, length-capped, allowed_mentions parse=[]
  DiscordREST-->>Responder: Created message JSON or API error
  Responder->>Outbox: ack on success/terminal 4xx, retry on 429/5xx

  User->>DiscordGateway: Later message inside tracked thread, no @ required
  DiscordGateway-->>GatewayDO: MESSAGE_CREATE payload for thread channel
  GatewayDO->>Queue: Enqueue message.received event (the DO cannot know it is a tracked thread)
  Consumer->>DB: SELECT rag_ai_threads by thread id, resolves a thread_reply in-process
  Consumer->>DiscordREST: GET thread messages before messageId, limit historyLimit
  Consumer->>AI: Chat request: stored initial prompt + thread history + current message
  Consumer->>Outbox: Enqueue reply.channel_message; responder posts into the thread
```

## Command-by-Command Details

### `/rag`

- Entry: interaction command routed in `workers/public/gateway/src/index.ts`
- Handler: `packages/domain/commands/rag.ts`
- Data path:
  - one D1 batch: insert `rag_events` row + upsert/increment `rag_totals ... RETURNING rag_count` (no follow-up SELECT)
- AI usage: none
- Response:
  - target mention + updated rag total

### `/ragboard`

- Entry: interaction command routed in `workers/public/gateway/src/index.ts`
- Handler: `packages/domain/commands/ragboard.ts`
- Data path:
  - select top 10 from `rag_totals` ordered by `rag_count`
- Response:
  - ranked leaderboard text or empty-state message

### `/ragspend`

- Entry: interaction command routed in `workers/public/gateway/src/index.ts`
- Handler: `packages/domain/commands/ragspend.ts`
- Data path:
  - reads the invoking user's precomputed total from `rag_ai_spend_totals`
- Response:
  - `<@user> has spent $x.xx`

### `/ragspendboard`

- Entry: interaction command routed in `workers/public/gateway/src/index.ts`
- Handler: `packages/domain/commands/ragspend.ts`
- Data path:
  - selects top 10 from `rag_ai_spend_totals` ordered by AI Gateway log cost
- Response:
  - ranked spend leaderboard text or empty-state message

### `/ask`

- Entry: interaction command routed in `workers/public/gateway/src/index.ts`
- Handler: `packages/domain/commands/ask.ts` (thread creation + enqueue) and `packages/domain/consumer.ts` (AI answer)
- Behavior:
  - defers the interaction
  - derives the thread title from the prompt (no model call)
  - creates a public Discord thread in the current channel
  - stores the thread in `rag_ai_threads`
  - edits the original interaction response with the thread link immediately
  - enqueues an `ask` job in `ai-jobs`; the queue consumer runs the model and posts the sanitized answer inside the thread (a failure notice is posted there if the model call fails)
  - automatically uses neutral web-search research mode when the prompt asks for current information

### `/bicture`

- Entry: interaction command routed in `workers/public/gateway/src/index.ts`
- Handler: `packages/domain/commands/bicture.ts` (enqueue) and `packages/domain/consumer.ts` (image generation)
- Behavior:
  - defers the interaction
  - enqueues an encoded `bicture` job in `ai-jobs`; the brain worker sends the prompt to the configured Unified Billing image model through the Workers AI binding and AI Gateway
  - records a pending AI spend event tagged with AI Gateway metadata
  - hands the image to the responder over the RPC binding, which edits the original interaction response with the attachment (text-only failure notices go through `discord-outbox`)
  - with this in place every AI/spend path is queue-driven; the interaction fetch path does no AI work

### `/ragjam`

- Entry: interaction command routed in `workers/public/gateway/src/index.ts`
- Handler: `packages/domain/commands/ragjam.ts`
- Behavior:
  - defers the interaction
  - sends `prompt`, `is_instrumental: false`, optional `lyrics`, and `lyrics_optimizer` to `minimax/music-2.6`
  - sets `lyrics_optimizer: true` when lyrics are omitted so the model auto-generates lyrics from the prompt
  - uses the configured AI Gateway id on the Workers AI binding for Unified Billing and spend reconciliation metadata
  - records a pending AI spend event tagged with AI Gateway metadata
  - downloads the generated audio URL and hands it to the responder over the RPC binding, which edits the original interaction response with a Discord audio attachment
  - falls back to the generated song URL as a text edit through `discord-outbox` if the audio cannot be attached

### Mention-based AI (not a slash command)

- Entry:
  - authenticated `POST /gateway/start` starts Durable Object gateway client
  - gateway listens for Discord `MESSAGE_CREATE`
- Handlers: `workers/public/gateway/src/gateway.ts` (connection) and `packages/domain/mention.ts` (DO-side encode + brain-side resolution)
- Queue and worker:
  - the DO enqueues every non-bot message with a usable prompt as a `message.received` event (no D1 thread lookup, no REST role fetch in the DO)
  - the brain resolves events into `channel_reply`/`thread_reply` work in-process: thread lookup, bot-role fetch for role mentions, mention resolution, and usage limits
  - channel replies answer in the same Discord channel and do not create or record a thread
  - `/ask` creates a Discord thread, records it in `rag_ai_threads`, and enqueues an `ask` job; the brain posts the answer inside that thread via the outbox
  - thread titles everywhere are derived from the user prompt (`sanitizeThreadTitle`), so no model call is spent on titles
  - later messages in a tracked thread resolve to `thread_reply` work automatically without requiring an @ mention
  - reply jobs build context from the stored initial prompt plus recent messages in that thread only
  - generated replies cross `discord-outbox` as raw model text; the responder sanitizes mentions/IDs on egress
- Delivery (always via the responder worker):
  - direct mentions post in the same Discord channel
  - `/ask` and tracked-thread follow-ups post inside the Discord thread

## Configuration

AI config is checked into `packages/ai/ai-config`:

- `discord-response.json` and `discord-response-system-prompt.md` control mention replies.
- `ask-web-search.json` and `ask-web-search-system-prompt.md` control `/ask` research mode.
- `bicture-image.json` controls `/bicture` image generation.
- `ragjam-music.json` controls `/ragjam` music generation.
- AI spend uses raw AI Gateway log cost. Requests are tagged with metadata so the spend worker can reconcile the exact log entry.

### AI usage limits

Every AI ingress (`/ask`, `/bicture`, `/ragjam`, and gateway mentions/tracked-thread replies) runs a shared pre-flight guard (`packages/domain/limits.ts`) before any model call or enqueue. The limits target attacker abuse, not heavy legitimate use — this is one server owned by friends:

- Per-user burst limit, recorded in the `rag_ai_requests` D1 table over the trailing minute. Generous for humans, catches floods and scripted spam. Configure with `AI_BURST_LIMIT_PER_MINUTE` (default `8`).
- Global daily budget across **all** users, summed from `rag_ai_spend_events` over the trailing 24 hours — the wallet backstop if any account is compromised. Configure with `AI_GLOBAL_DAILY_BUDGET_USD` (default `10.00`). Events still pending cost reconciliation count as zero, so the budget is best-effort.

The guard fails open on D1 errors, and the `/rag` command family is not rate limited.

## Workers, Trust Zones, and Secrets

| Worker | Config | Trust zone / role | Secrets |
| --- | --- | --- | --- |
| `ragbot-worker` | `workers/public/gateway/wrangler.jsonc` | Public entrypoint (`/discord`, gateway control) + `DiscordGateway` Durable Object. The DO keeps only the WebSocket lifecycle + IDENTIFY (bot token, unavoidable), payload validation, and encode+enqueue of `message.received` events — it uses no D1 and no Discord REST | `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` (DO IDENTIFY + interaction-path Discord REST), `GATEWAY_CONTROL_TOKEN` |
| `ragbot-brain-worker` | `workers/services/brain/wrangler.jsonc` | `ai-jobs` consumer: **read Discord + AI + D1**. Resolves raw `message.received` events (thread lookup, mention/role resolution, usage limits) in-process, reads thread history, replied-to messages, and bot roles over Discord REST, and creates `/ask`-style threads; every message/edit it produces leaves via the outbox queue or the responder RPC binding, never directly | `CF_AIG_TOKEN` (belongs to brain **only** — remove it from `ragbot-worker` with `wrangler secret delete CF_AIG_TOKEN`), `DISCORD_BOT_TOKEN` (honestly required: Discord *reads* need the bot token too, so the brain keeps it even though writes go through the responder) |
| `ragbot-responder-worker` | `workers/services/responder/wrangler.jsonc` | **Write Discord** — the single egress choke point. No public route. Consumes `discord-outbox` for text replies and exposes the `Responder` RPC entrypoint for media-bearing interaction edits. The only place `sanitizeAiText`, the message length cap, and `allowed_mentions: { parse: [] }` run on AI output before it reaches Discord | `DISCORD_BOT_TOKEN` |
| `ragbot-spend-worker` | `workers/services/spend/wrangler.jsonc` | `ai-spend-jobs` consumer: AI Gateway log reconciliation | `CLOUDFLARE_API_TOKEN` (scoped to AI Gateway read) |

Set a secret on a specific worker with `wrangler secret put NAME -c workers/services/brain/wrangler.jsonc` (or the matching config file).

### Discord egress design

- **Text-only replies** (channel/thread posts, text interaction edits) go through the durable, retryable `discord-outbox` queue as encoded/validated envelopes (`reply.channel_message`, `reply.interaction_edit`).
- **Media-bearing interaction edits** (`/bicture` image, `/ragjam` audio) go over a **service-binding RPC** (`Responder.deliverInteractionEdit`) instead: queue messages are capped at 128 KiB, the media bytes are already in brain memory, and a queue retry would regenerate the media anyway. RPC is direct worker-to-worker with no network exposure.
- The brain sends **raw model text** over the outbox; the responder applies the final output policy (sanitize, truncate to `MAX_DISCORD_MESSAGE_LENGTH`, `allowed_mentions: { parse: [] }`). `rag_ai_interactions.response_text` still records the **sanitized** text (the brain computes the same pure policy function for the record), and `status = 'ok'` now means "handed to the outbox" — delivery failures show up in responder logs and its DLQ, not in that column.
- Interaction-edit text (prompt echoes, failure notices) is not model output: the responder caps it at the Discord 2000-char hard limit and locks down `allowed_mentions`, but does not run `sanitizeAiText` speaker-line stripping over it.
- **Deliberate boundary:** the main worker's deferred `/rag`-family and `/ask` responses still PATCH the interaction webhook directly. Interaction tokens are scoped and short-lived, the main worker owns the interaction, and no bot token is involved (webhook edits are token-authenticated), so this stays outside the responder.

### Gateway ingress design

The `DiscordGateway` Durable Object treats `MESSAGE_CREATE` as a second untrusted ingress: it validates the payload shape, encodes a `message.received` envelope (ids, length-capped content, author, mentions, mention roles, reply metadata), and enqueues it — nothing else. Because thread tracking lives in D1 and the DO deliberately has no D1 or REST access, it cannot know locally whether a non-mention message belongs to a tracked thread, so every non-bot message with a non-empty stripped prompt is enqueued and the brain filters. That trades queue volume for isolation, which is fine for a single small guild. The brain then does the thread lookup, bot-role fetch, mention resolution, and rate/budget checks, and processes the resolved reply in the same invocation (no re-enqueue); denial notices leave via the outbox.

**Deliberate deviation from RECOMMENDATIONS.md section 1:** the DO stays hosted in the main worker rather than moving to a dedicated listener worker — moving a Durable Object class between scripts requires a risky transfer migration. Documented here as a possible future step instead.

## Local and Deploy Commands

`./deploy.sh`

`npm run dev:all` runs the Discord worker, the brain worker, the responder worker, and the spend worker locally.

`npm run deploy` deploys all workers (responder first, so the brain's service binding target exists). Use `npm run deploy:main`, `npm run deploy:brain`, `npm run deploy:responder`, or `npm run deploy:spend` to deploy one worker.

### One-time bootstrap

Queues must exist before the first deploy of a config that references them:

```sh
wrangler queues create ai-jobs
wrangler queues create ai-jobs-dlq
wrangler queues create ai-spend-jobs
wrangler queues create ai-spend-jobs-dlq
wrangler queues create discord-outbox
wrangler queues create discord-outbox-dlq
```
