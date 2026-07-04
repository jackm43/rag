# ragbot-worker

Cloudflare Worker Discord bot for rag tracking, direct mention replies, and thread-based `/ask` conversations.

## Tech Stack

- Runtime: Cloudflare Workers (`workers/applications/gateway/api/middleware_client/src/index.ts`, `workers/services/workflows/src/index.ts`, `workers/services/responder/src/index.ts`, `workers/services/spend/src/index.ts`)
- Language: TypeScript
- Database: Cloudflare D1 (`DB`); schema lives in `migrations/` and is applied with `wrangler d1 migrations apply` (`npm run d1:migrate:local` / `d1:migrate:remote`). The wrangler configs deliberately set no `preview_database_id` — it used to point at the production database. If preview deployments are ever used, create a separate preview DB (`wrangler d1 create ragbot-preview`) and add its id as `preview_database_id`. `schema.sql` is a reference-only mirror of the full current schema — change the schema by adding a migration, not by editing it. No migration ALTERs `rag_ai_interactions` to add the token-usage columns: SQLite has no `ADD COLUMN IF NOT EXISTS`, the prod table may or may not already have them, and a failing ALTER would strand deploys, so `recordAiInteraction` keeps its dual-INSERT fallback until prod's shape is verified (`PRAGMA table_info(rag_ai_interactions)`)
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
  - `POST /gateway/stop` stop gateway connection (`GATEWAY_CONTROL_TOKEN` auth)
  - `GET /gateway/health` gateway status (`GATEWAY_CONTROL_TOKEN` auth)
- All other public paths, including `/` and source-file-looking paths, return `404`.

## Public Route Boundary

```mermaid
flowchart LR
  Discord[Discord Interactions] -->|POST /discord: signed interaction JSON| Worker
  Worker -->|200 JSON: interaction response| Discord

  Operator[Operator] -->|POST /gateway/start: Bearer GATEWAY_CONTROL_TOKEN| Worker
  Operator -->|POST /gateway/stop: Bearer GATEWAY_CONTROL_TOKEN| Worker
  Operator -->|GET /gateway/health: Bearer GATEWAY_CONTROL_TOKEN| Worker
  Worker -->|typed Durable Object RPC: start, stop, or health| GatewayDO[DiscordGateway Durable Object]
  GatewayDO -->|JSON: start/stop result or health state| Worker
  Worker -->|JSON response| Operator

  Unknown[Other public request] -->|any unconfigured path or method| Worker
  Worker -->|404 Not found, or 405 on configured paths with the wrong method| Unknown
```

The gateway control endpoints authenticate with a dedicated `GATEWAY_CONTROL_TOKEN` secret, never the Discord bot token, and fail closed with `401` when the secret is not configured. `POST /gateway/start` is idempotent; `POST /gateway/stop` is the kill switch — it clears the enabled flag, cancels the watchdog alarm, closes the socket, and resets resume state, so a stopped gateway stays down (no reconnect on close events or alarms) until the next start. Operators must create it before use: set it on the worker with `wrangler secret put GATEWAY_CONTROL_TOKEN` and add a matching `GATEWAY_CONTROL_TOKEN` field to the 1Password `ragbot` item referenced by `.env` so `deploy.sh` can send it.

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
  participant Consumer as Workflows worker queue consumer
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
  Consumer->>DB: SELECT rag_ai_threads by channel id (thread tracking lives workflows-side)
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

- Entry: interaction command routed in `workers/applications/gateway/api/middleware_client/src/index.ts`
- Handler: `packages/domain/commands/rag.ts`
- Data path:
  - one D1 batch: insert `rag_events` row + upsert/increment `rag_totals ... RETURNING rag_count` (no follow-up SELECT)
- AI usage: none
- Response:
  - target mention + updated rag total

### `/ragboard`

- Entry: interaction command routed in `workers/applications/gateway/api/middleware_client/src/index.ts`
- Handler: `packages/domain/commands/ragboard.ts`
- Data path:
  - select top 10 from `rag_totals` ordered by `rag_count`
- Response:
  - ranked leaderboard text or empty-state message

### `/ragspend`

- Entry: interaction command routed in `workers/applications/gateway/api/middleware_client/src/index.ts`
- Handler: `packages/domain/commands/ragspend.ts`
- Data path:
  - reads the invoking user's precomputed total from `rag_ai_spend_totals`
- Response:
  - `<@user> has spent $x.xx`

### `/ragspendboard`

- Entry: interaction command routed in `workers/applications/gateway/api/middleware_client/src/index.ts`
- Handler: `packages/domain/commands/ragspend.ts`
- Data path:
  - selects top 10 from `rag_ai_spend_totals` ordered by AI Gateway log cost
- Response:
  - ranked spend leaderboard text or empty-state message

### `/ask`

- Entry: interaction command routed in `workers/applications/gateway/api/middleware_client/src/index.ts`
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

- Entry: interaction command routed in `workers/applications/gateway/api/middleware_client/src/index.ts`
- Handler: `packages/domain/commands/bicture.ts` (enqueue) and `packages/domain/consumer.ts` (image generation)
- Behavior:
  - defers the interaction
  - enqueues an encoded `bicture` job in `ai-jobs`; the workflows worker sends the prompt to the configured Unified Billing image model through the Workers AI binding and AI Gateway
  - records a pending AI spend event tagged with AI Gateway metadata
  - hands the image to the responder over the RPC binding, which edits the original interaction response with the attachment (text-only failure notices go through `discord-outbox`)
  - with this in place every AI/spend path is queue-driven; the interaction fetch path does no AI work

### `/ragjam`

- Entry: interaction command routed in `workers/applications/gateway/api/middleware_client/src/index.ts`
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
- Handlers: `workers/applications/gateway/service_server/src/gateway.ts` (connection) and `packages/domain/mention.ts` (DO-side encode + workflows-side resolution)
- Queue and worker:
  - the DO enqueues every non-bot message with a usable prompt as a `message.received` event (no D1 thread lookup, no REST role fetch in the DO)
  - the workflows worker resolves events into `channel_reply`/`thread_reply` work in-process: thread lookup, bot-role fetch for role mentions, mention resolution, and usage limits
  - channel replies answer in the same Discord channel and do not create or record a thread
  - `/ask` creates a Discord thread, records it in `rag_ai_threads`, and enqueues an `ask` job; the workflows worker posts the answer inside that thread via the outbox
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

#### AI config in KV (`AI_CONFIG`)

The workflows worker — the only worker that runs AI — binds a Workers KV namespace `AI_CONFIG` (`workers/services/workflows/wrangler.jsonc`). `loadConfig` (`packages/ai/config.ts`) reads each prompt/config from KV first, keyed by the file's **basename** (`discord-response.json`, `ask-web-search.json`, `discord-response-system-prompt.md`, `ask-web-search-system-prompt.md`), and **falls back to the copy bundled into the worker** (the `import`ed file) on a miss, a null value, a KV error, or when the binding is absent. The bundled files stay checked into `packages/ai/ai-config` as both the fallback and the source of truth that `config:push` uploads, so a fresh/empty namespace or a KV outage never bricks the bot.

`loadConfig` memoizes the resolved config **per isolate, forever** — the KV read happens once per isolate. KV values can change between deploys, but a deploy or an isolate recycle is what re-resolves them, which is fine for this bot. To publish a prompt change:

- **Without a redeploy:** edit the file in `packages/ai/ai-config`, run `npm run config:push`; new isolates pick up the new value (existing warm isolates keep the old one until they recycle).
- **Or redeploy** the workflows worker, which both re-bundles the fallback and starts fresh isolates.

`npm run config:push` (`scripts/push-config.ts`) uploads every file in `packages/ai/ai-config` to `AI_CONFIG` via `wrangler kv key put <basename> --path <file> --binding AI_CONFIG`. `deploy.sh` runs it automatically after `npm run deploy`.

### AI usage limits

Every AI ingress (`/ask`, `/bicture`, `/ragjam`, and gateway mentions/tracked-thread replies) runs a shared pre-flight guard (`packages/domain/limits.ts`) before any model call or enqueue. The limits target attacker abuse, not heavy legitimate use — this is one server owned by friends:

- Per-user burst limit, recorded in the `rag_ai_requests` D1 table over the trailing minute. Generous for humans, catches floods and scripted spam. Configure with `AI_BURST_LIMIT_PER_MINUTE` (default `8`).
- Global daily budget across **all** users, summed from `rag_ai_spend_events` over the trailing 24 hours — the wallet backstop if any account is compromised. Configure with `AI_GLOBAL_DAILY_BUDGET_USD` (default `10.00`). Events still pending cost reconciliation count as zero, so the budget is best-effort.

The guard fails open on D1 errors, and the `/rag` command family is not rate limited.

### Guild allowlist

`ALLOWED_GUILD_IDS` (comma-separated guild snowflakes, e.g. `ALLOWED_GUILD_IDS="123456789012345678"`) gates every ingress through `packages/domain/guilds.ts`:

- Interactions: non-allowed guilds get "This bot only works in its home server." (PING stays exempt so Discord's endpoint verification keeps working).
- Gateway `MESSAGE_CREATE`: the Durable Object drops events from non-allowed guilds before enqueueing; DMs (no guild id) are denied.
- Workflows `message.received` processing repeats the check (zero-trust between queue hops).

When set, the gate fails closed — unparseable entries are dropped, so a misconfigured value denies everything. When unset, the gate allows all guilds but logs `allowed_guild_ids_unset` once per isolate, so existing deploys keep working until the var is configured. Set it in the gateway and workflows wrangler configs (documented placeholders are in each `vars` block).

## Trust Boundaries

Trust zones are ordered from least to most trusted: **Untrusted** (public callers) → **Edge** (the gateway) → **Applications** (workflows, responder, spend) → **Trusted** (the service registry, signing roots). Every hop into, between, and out of the workers crosses a named boundary, carrying a uniform context and logging denials in one shape (`{identity, zone, transport, outcome: "denied", reason}`). The Cedar policy engine (see [Authorization](#authorization-cedar)) evaluates at exactly these choke points.

| Boundary | Module | Shape |
| --- | --- | --- |
| Inbound (untrusted → edge) | `packages/boundaries/inbound` | Guards (`{identity, verify}`) that yield a typed principal (`discord` + verified interaction, `operator`) or a typed denial (reason + HTTP response) |
| Service (edge/applications ↔ applications) | `packages/auth` | `serviceClients(env)` clients mint a signed identity-context token beside the contracts-encoded envelope; `createServiceServer` receives verify the token (signature, audience, expiry, envelope-hash binding) **before** the forwarding authorizer runs Cedar `service.invoke`, so the principal Cedar sees is cryptographically established. See [Identity exchange](#identity-exchange-on-service-hops) |
| Outbound (→ external) | `packages/boundaries/outbound` | Per-identity boundary clients enforcing credential injection, host allowlists, https-only, timeouts, and response-size caps; failure logs redact paths for identities whose paths embed credentials (`logPath: false` for `discord-webhook` and `media-download`) |

HTTP surfaces live under `workers/applications/*/api/middleware_client` and are **constructed from application bindings**. Gateway, metadata, attest, registry, webhooks, and dev-proxy each define route metadata in `src/application-bindings.ts`; `npm run routes:build` generates `openapi.yaml` and `src/openapi.ts` for each, plus the gateway route table. The gateway router wires paths, methods, and security schemes (ingress guards) to operationId handlers from its generated route table — an operation without a handler fails construction. Worker-to-worker traffic is queues/worker RPC carrying Cap'n Proto: the queue hop body is a capnp `ServiceMessage` (`packages/contracts/service.capnp`) framing the envelope bytes with the JWS identity token, and the registry RPC exchanges capnp `ServiceManifest`/`ManifestSnapshot` payloads.

Registry application registration is not queue-backed: the registry middleware authenticates the request, then invokes the `REGISTRY_SERVICE` binding (`RegistryService` entrypoint) to mutate `ApplicationRegistry`, build scaffold artifacts, store the scaffold result, and optionally submit the GitHub PR through the connectors broker.

## Authorization (Cedar)

All allow/deny decisions are centralised in `packages/authz` and evaluated by [Cedar](https://www.cedarpolicy.com/) (`@cedar-policy/cedar-wasm`, compiled at deploy time via wrangler's CompiledWasm rule and instantiated once per isolate). Principals follow RFC naming: `Human` (Discord users) and `Machine` (services and the operator control plane).

- **Policies** live in `packages/authz/policies/*.cedar` (`commands.cedar` for the slash-command surface incl. the admin gate and raghammer-ban forbid, `operator.cedar` for the `/gateway/*` control plane, `services.cedar` for worker-to-worker hops, `devproxy.cedar` for the dev-proxy capability surface). `services.cedar` carries two actions: `service.invoke` (evaluated at receive time on the verified issuer) and `service.exchange` (evaluated on first use of a service client with the hop's `{fromZone, toZone}` context, so an unauthorized hop yields a fail-closed client). `devproxy.cedar` carries `devproxy.invoke` (evaluated with the `dev-proxy` machine principal against a `DevProxy` resource with the command in context) — the app-level surface bounding which commands the dev application may proxy, independent of the ordinary per-user `command.*` gate that then runs. Each policy carries an `@id` annotation that denial diagnostics surface as the reason.
- **Registry-driven policy**: services register a manifest (zone, targets, operations) with the `ServiceRegistry` Durable Object on startup; the registry snapshot is merged into the Cedar entity store, and the `invoke-registered` / `exchange-registered` attribute rules authorize registered pairs. The static per-hop permits in `services.cedar` remain as the bootstrap fallback when the registry is empty or unreachable (fail closed to those permits, never open).
- **Forwarding authorizer**: `authorizeAndForward` (`packages/authz/forward.ts`) puts authorization structurally on the request path — either the request is authorized and forwarded, or it exits with a logged denial; there is no boolean for a caller to ignore.
- **To add an admin**, add the Discord user id to `RAG_ADMIN_USER_IDS` in `packages/authz/entities.ts` — membership of the `Group::"rag-admins"` entity is data, not policy.
- **`authorize()` runs** at three choke points: the command registry pre-flight (`packages/domain/commands/registry.ts`, plus `/rag`'s in-window ban decision in `rag.ts`) with the D1-fetched ban state passed as `context.banned`; the gateway control routes after the operator bearer-token guard (`workers/applications/gateway/api/middleware_client/src/index.ts`, principal `Machine::"operator"`); and every service receive/exchange via the forwarding authorizer inside `packages/auth`. Everything is deny-by-default — an action nobody permitted is refused.

The guild allowlist deliberately stays at ingress (`packages/domain/guilds.ts`), not in Cedar, for now.

## Identity exchange on service hops

Every worker-to-worker hop carries a **signed identity-context token** (`packages/identity`) alongside the Cap'n Proto envelope, so the subject and the minting service are cryptographically established rather than asserted.

**Why not literal mTLS?** Cloudflare service bindings and queues are in-process, isolate-to-isolate calls within one account: a binding/queue can only be invoked by a worker configured with it, so the platform *already* guarantees the transport identity ("which worker is calling"). That platform guarantee is the practical equivalent of mTLS transport-level identity here — there are no sockets to negotiate TLS on, so we do not (and cannot, and need not) implement literal mTLS. What the platform does not carry is the *application* identity: who the request acts on behalf of, and an explicit, testable proof of the minting service. The identity-context token layers exactly that on top.

**The token** (compact JWS, Ed25519/EdDSA) binds `{sub, act, iss, aud, trustZone, iat, exp (60s), jti, envelopeSha256}` — RFC 8693 vocabulary: `sub` is the **subject** (the Discord user the request acts for, or `"system"` for user-less flows like spend reconciliation), `act` is the **delegation chain** of machine principals traversed, `aud` is the **target** service. `envelopeSha256` binds the token to one payload so a captured token cannot be replayed against different bytes. It rides as a sibling to the envelope: the queue body is a capnp `ServiceMessage` (`service.capnp`) framing `{envelope :Data, idToken :Text}`, and the responder binding takes `idToken` as a third RPC argument. The token itself stays a compact JWS string — RFC 7515 fixes its JSON payload format, so capnp carries it rather than redefining it.

**The flow (RFC 8693-style token exchange, one exchange per hop):**

```
Discord (untrusted) → gateway (edge; verifies interaction/gateway signature)
        → mints ORIGIN context: iss=gateway, aud=workflows, sub=<discord user id>
        → workflows (application) verifies (sig + aud=workflows + envelope hash) → Cedar service.invoke
        → re-mints on behalf of the SAME sub: iss=workflows, aud=responder|spend, act+=workflows
        → responder / spend (application) verify → Cedar → process
        → responder re-mints for aud=egress before Discord writes
        → egress verifies → host/profile policy → injects provider credential
```

At each receive the token is verified **before** Cedar runs, and the verified issuer becomes the Cedar `Machine` principal; any failure denies with the shared `service_denied` log shape and the message is dropped/acked. On success the handler receives the full verified `RequestContext` (subject, delegation chain, source, zone, transport) alongside the decoded payload.

**Key provisioning.** Each sending worker holds a private Ed25519 signing key as a secret; public keys are committed (not secret) in `packages/identity/keyring.ts`. Generate a keypair with `tsx scripts/generate-keys.ts <worker>`, then:

```sh
wrangler secret put GATEWAY_SIGNING_KEY -c workers/applications/gateway/api/middleware_client/wrangler.jsonc
wrangler secret put WORKFLOWS_SIGNING_KEY   -c workers/services/workflows/wrangler.jsonc
wrangler secret put RESPONDER_SIGNING_KEY   -c workers/services/responder/wrangler.jsonc
wrangler secret put REGISTRY_SIGNING_KEY    -c workers/applications/registry/api/middleware_client/wrangler.jsonc
wrangler secret put METADATA_SIGNING_KEY    -c workers/applications/metadata/api/middleware_client/wrangler.jsonc
wrangler secret put ATTEST_SIGNING_KEY      -c workers/applications/attest/api/middleware_client/wrangler.jsonc
```

The gateway (origin mint), workflows (downstream re-mint), responder (Discord-write egress hop), registry, metadata, attest, webhooks, and dev-proxy sign. Spend and egress are receivers only unless they later call another internal service. To rotate a key, deploy the new private key to the secret and update the public JWK in `keyring.ts`.

The identity-context token supports two optional session-binding claims, `dpopJkt` and `sid`, present only on an edge hop and absent on every service-to-service hop, so the verifier and existing minters are unchanged. The dev-proxy hop no longer populates them — the session is bound to the Cloudflare Access identity in the `ragbot-auth` store (see [Dev proxy](#dev-proxy-admin-application-that-runs-in-production)), not by a per-request proof.

## Workers, Trust Zones, and Secrets

| Worker | Config | Trust zone / role | Secrets |
| --- | --- | --- | --- |
| `ragbot-worker` | `workers/applications/gateway/api/middleware_client/wrangler.jsonc` | Public entrypoint (`/discord`, gateway control) + `DiscordGateway` Durable Object. The DO keeps only the WebSocket lifecycle + IDENTIFY (bot token, unavoidable), payload validation, and encode+enqueue of `message.received` events — it uses no D1 and no Discord REST | `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` (DO IDENTIFY + interaction-path Discord REST), `GATEWAY_CONTROL_TOKEN`, `GATEWAY_SIGNING_KEY` (mints origin identity-context tokens) |
| `ragbot-workflows-worker` | `workers/services/workflows/wrangler.jsonc` | `ai-jobs` consumer: **read Discord + AI + D1**. Resolves raw `message.received` events (thread lookup, mention/role resolution, usage limits) in-process, reads thread history, replied-to messages, and bot roles over Discord REST, and creates `/ask`-style threads; every message/edit it produces leaves via the outbox queue or the responder RPC binding, never directly | `CF_AIG_TOKEN` (belongs to workflows **only** — remove it from `ragbot-worker` with `wrangler secret delete CF_AIG_TOKEN`), `DISCORD_BOT_TOKEN` (honestly required: Discord *reads* need the bot token too, so the workflows worker keeps it even though writes go through the responder), `WORKFLOWS_SIGNING_KEY` (re-mints on-behalf-of identity-context tokens for the responder and spend hops) |
| `ragbot-responder-worker` | `workers/services/responder/wrangler.jsonc` | **Discord output policy**. No public route. Consumes `discord-outbox` for text replies and exposes the `Responder` RPC entrypoint for media-bearing interaction edits. The only place `sanitizeAiText`, the message length cap, and `allowed_mentions: { parse: [] }` run on AI output before it reaches Discord; then it signs a request to the bound `EGRESS` worker | `RESPONDER_SIGNING_KEY` |
| `ragbot-egress-worker` | `workers/services/egress/wrangler.jsonc` | Generic bound egress proxy. Verifies signed `egress.request` envelopes, enforces the selected egress profile's host/timeout/response-size policy, injects the profile credential, and performs the outbound fetch. Discord is currently profiles `discord-rest` and `discord-webhook`; the same worker code can be deployed with other profiles for connectors/GitHub | `DISCORD_BOT_TOKEN` for `discord-rest`; optional `EGRESS_PROFILES_JSON` for additional profiles |
| `ragbot-spend-worker` | `workers/services/spend/wrangler.jsonc` | `ai-spend-jobs` consumer: AI Gateway log reconciliation | `CLOUDFLARE_API_TOKEN` (scoped to AI Gateway read) |
| `ragbot-registry-worker` | `workers/applications/registry/api/middleware_client/wrangler.jsonc` | Registry application plus trusted service registry Durable Objects. HTTP middleware authenticates registry users, then invokes `RegistryService` with signed `registry.invoke` messages for application CRUD/scaffold work | `REGISTRY_SIGNING_KEY`, Better Auth/Cloudflare Access secrets |
| `ragbot-metadata-worker` | `workers/applications/metadata/api/middleware_client/wrangler.jsonc` | `metadata.jsmunro.me` GraphQL metadata app. HTTP middleware validates bearer-token GraphQL requests, then invokes `MetadataService` with signed `metadata.query` messages; service resolvers read registry metadata and verify stored artifact attestations | `METADATA_QUERY_TOKEN`, `METADATA_SIGNING_KEY` |
| `ragbot-attest-worker` | `workers/applications/attest/api/middleware_client/wrangler.jsonc` | GitHub artifact attestation ingestion and attestation store. Verifies GitHub webhooks through the connectors broker and stores attested artifact hashes/scopes | `ATTEST_SIGNING_KEY` |
| `ragbot-dev-proxy-worker` | `workers/applications/dev-proxy/api/middleware_client/wrangler.jsonc` | Public **admin app that runs in prod**: behind Cloudflare Access, with Better Auth (Discord OAuth) app identity on a standalone `ragbot-auth` D1; resolves the acting Discord subject from the session, then invokes the gateway's `DevProxy` service binding as the `dev-proxy` machine principal. No dev environment, no dev data — see [Dev proxy](#dev-proxy-admin-application-that-runs-in-production) | `DEV_PROXY_SIGNING_KEY`, `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`, `BETTER_AUTH_SECRET` |
| `ragbot-webhooks-worker` | `workers/applications/webhooks/api/middleware_client/wrangler.jsonc` | Public provider webhook ingress. Verifies signatures through the connectors broker, dedupes valid event ids, and enqueues signed `webhook.event` messages to workflows | `WEBHOOKS_SIGNING_KEY` |

Set a secret on a specific worker with `wrangler secret put NAME -c workers/services/workflows/wrangler.jsonc` (or the matching config file).

### Discord egress design

- **Text-only replies** (channel/thread posts, text interaction edits) go through the durable, retryable `discord-outbox` queue as encoded/validated envelopes (`reply.channel_message`, `reply.interaction_edit`).
- **Media-bearing interaction edits** (`/bicture` image, `/ragjam` audio) go over a **service-binding RPC** (`Responder.deliverInteractionEdit`) instead: queue messages are capped at 128 KiB, the media bytes are already in workflows memory, and a queue retry would regenerate the media anyway. RPC is direct worker-to-worker with no network exposure.
- The responder owns Discord message policy, then calls the bound generic `Egress` worker using a signed `egress.request` envelope. The egress worker owns the Discord bot token and host/profile policy. This pattern is intentionally provider-neutral: connectors/GitHub can bind a separately configured egress worker with their own profiles.
- The workflows worker sends **raw model text** over the outbox; the responder applies the final output policy (sanitize, truncate to `MAX_DISCORD_MESSAGE_LENGTH`, `allowed_mentions: { parse: [] }`). `rag_ai_interactions.response_text` still records the **sanitized** text (the workflows worker computes the same pure policy function for the record), and `status = 'ok'` now means "handed to the outbox" — delivery failures show up in responder logs and its DLQ, not in that column.
- Interaction-edit text (prompt echoes, failure notices) is not model output: the responder caps it at the Discord 2000-char hard limit and locks down `allowed_mentions`, but does not run `sanitizeAiText` speaker-line stripping over it.
- **Deliberate boundary:** the main worker's deferred `/rag`-family and `/ask` responses still PATCH the interaction webhook directly. Interaction tokens are scoped and short-lived, the main worker owns the interaction, and no bot token is involved (webhook edits are token-authenticated), so this stays outside the responder.

### Gateway ingress design

The `DiscordGateway` Durable Object treats `MESSAGE_CREATE` as a second untrusted ingress: it validates the payload shape, encodes a `message.received` envelope (ids, length-capped content, author, mentions, mention roles, reply metadata), and enqueues it — nothing else. Because thread tracking lives in D1 and the DO deliberately has no D1 or REST access, it cannot know locally whether a non-mention message belongs to a tracked thread, so every non-bot message with a non-empty stripped prompt is enqueued and the workflows worker filters. That trades queue volume for isolation, which is fine for a single small guild. The workflows worker then does the thread lookup, bot-role fetch, mention resolution, and rate/budget checks, and processes the resolved reply in the same invocation (no re-enqueue); denial notices leave via the outbox.

**Deliberate deviation from RECOMMENDATIONS.md section 1:** the DO stays hosted in the main worker rather than moving to a dedicated listener worker — moving a Durable Object class between scripts requires a risky transfer migration. Documented here as a possible future step instead.

## Dev proxy (admin application that runs in production)

The `ragbot-dev-proxy-worker` (`workers/applications/dev-proxy`) is the human-facing **admin application** for ragbot: it lets an operator exercise the **real** gateway → workflows command path (and, over time, other sensitive service surfaces) against **real** data with no separate dev environment, dev client, or dev data. It is a public edge worker with a **layered auth model**, and its hop into the gateway is authorized identically to a Discord-initiated command — plus two extra app-level gates.

**Why this shape.** The gateway's existing ingresses are HTTP guards (Discord Ed25519 signature, operator control token). Rather than bolt a third public HTTP surface onto the gateway, the dev-proxy is a *separate* worker that reaches the gateway over a **service binding** — a hop invocable only by a worker configured with it, so the gateway's `DevProxy` entrypoint is reachable only from the dev-proxy and never from the public internet. The dev-proxy is a first-class `dev-proxy` machine principal (edge zone) with its own Ed25519 signing key, so its hop carries the same cryptographic identity as the gateway/workflows hops.

**The layered auth model** (outer gate to inner):

1. **Cloudflare Access — the perimeter.** The whole worker sits behind an Access application; the worker cryptographically verifies the Access JWT on **every** request (including the login endpoints), so nothing behind Access is reachable without a verified team identity.
2. **Better Auth with Discord OAuth — the app identity**, running *behind* Access. The operator signs in with Discord; the logged-in user's **Discord account id becomes the acting subject** the gateway command runs as. Better Auth is authN only — **Cedar remains the authZ engine**. Login/session/callback are served by Better Auth under `/api/auth/*`, backed by a standalone `ragbot-auth` D1 database.
3. **Session ↔ Access binding.** Each Better Auth session is bound at creation to the Access identity that made it (the verified Access `sub` is stamped onto the session row, `session.accessSub`). The command gate refuses a session presented under any *other* Access identity, so a leaked session cookie cannot be replayed cross-identity by another team member.

**Request flow and its fail-closed gates:**

```
Browser (untrusted)
  │  Cloudflare Access (org SSO) in front of the whole worker
  ▼
dev-proxy worker (edge)
  1. cf-access guard (perimeter, EVERY request) — verify the Access JWT
     (RS256/ES256) against the team JWKS: iss, aud, exp/nbf. Fails closed if
     CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD unset.
  2. Better Auth session — POST /api/command requires a valid session with a
     linked Discord account whose bound accessSub equals THIS request's Access
     sub (else 401). The acting subject is the session's Discord account id.
  3. mint on-behalf-of token: sub = the acting Discord id, bound to the Cap'n
     Proto devproxy.command envelope; call the gateway DevProxy binding
  ▼
gateway DevProxy entrypoint (edge)
  4. createServiceServer verification — Ed25519 signature, aud=gateway, iss=dev-proxy,
     exp, envelope-hash binding; registration gate (only devproxy.command); Cedar
     service.invoke for the dev-proxy app.
  5. acting Discord subject must be in DEV_PROXY_ALLOWED_SUBJECTS (unset denies all) —
     defense in depth, independent of who passed Access/Discord upstream.
  6. Cedar devproxy.invoke — the app-level capability surface (which commands the dev
     app may proxy at all; devproxy.cedar grants the public commands, withholds admin).
  7. the ORDINARY command pre-flight (routeInteraction → executeCommand): guild
     allowlist, per-user Cedar command.*, raghammer ban, usage limits — identical to a
     Discord-initiated command.
```

Any failure returns a bare status and never discloses which gate refused. Inline commands (`/ragboard`, `/ragspend`, …) round-trip their result to the browser. Enqueue/AI commands (`/ask`, `/bicture`, `/ragjam`) run the full authorized path and enqueue to the workflows worker; because there is no real Discord interaction, the final Discord edit targets the real application id with a synthetic interaction token (a no-op at Discord), so the AI/D1/spend work runs and is observable while the browser sees the deferred acknowledgement.

**Why Better Auth on D1.** Better Auth runs on workerd (verified under `@cloudflare/vitest-pool-workers`) and natively detects a Cloudflare D1 binding — passing the `AUTH_DB` binding directly uses its built-in D1 dialect, so there is no extra Kysely dependency. The schema is applied out-of-band as a committed D1 migration (`workers/applications/dev-proxy/api/middleware_client/migrations`); Better Auth never introspects at runtime (D1 forbids the `sqlite_master` reads its migrator needs). The auth database is kept **separate** from the gateway's `ragbot` operational DB so login/session state never mingles with product data. The Discord OAuth access/refresh tokens live server-side in `AUTH_DB` and are never sent to the browser — the browser only holds an opaque session cookie.

**Contracts.** The public ingress is described by `workers/applications/dev-proxy/api/middleware_client/openapi.yaml` (OpenAPI 3.1 with `cfAccess` + `betterAuthSession` security schemes) and validated at runtime with zod; the generated types (`packages/devproxy-client/api-types.ts`, `npm run devproxy:types`) are committed and the worker's zod schema `satisfies` them so ingress and client cannot drift. The service-binding payload is Cap'n Proto (`DevProxyCommandPayload` in `envelope.capnp`), reusing the same generated contract layer as the queue hops. `packages/devproxy-client` is a dumb typed client: it owns no credentials — the caller supplies the Access token and/or session cookie through hooks.

**Bootstrap.** Generate the signing key, register the Discord OAuth app, apply the auth schema, and put an Access application in front of the hostname:

```sh
tsx scripts/generate-keys.ts dev-proxy
# commit the printed public JWK to keyring.ts (already done for the current key), then:
wrangler secret put DEV_PROXY_SIGNING_KEY -c workers/applications/dev-proxy/api/middleware_client/wrangler.jsonc

# Discord OAuth app credentials + Better Auth secrets (secrets, never committed):
wrangler secret put DISCORD_CLIENT_ID     -c workers/applications/dev-proxy/api/middleware_client/wrangler.jsonc
wrangler secret put DISCORD_CLIENT_SECRET -c workers/applications/dev-proxy/api/middleware_client/wrangler.jsonc
wrangler secret put BETTER_AUTH_SECRET    -c workers/applications/dev-proxy/api/middleware_client/wrangler.jsonc   # random 32+ bytes

# apply the Better Auth schema to the standalone ragbot-auth D1 database:
wrangler d1 migrations apply ragbot-auth -c workers/applications/dev-proxy/api/middleware_client/wrangler.jsonc --remote
```

In the **Discord developer portal**, add the OAuth2 redirect URI `https://ragbot-dev.jsmunro.me/api/auth/callback/discord`. Set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `BETTER_AUTH_URL` (`https://ragbot-dev.jsmunro.me`), and `DEV_PROXY_GUILD` as vars on the dev-proxy worker, and keep the `DEV_PROXY_ALLOWED_SUBJECTS` var (the allowlist of Discord ids the proxy may act as) on the **gateway** worker. `DEV_PROXY_SUBJECT` is no longer used — the subject comes from the Discord session. Deploy the gateway before the dev-proxy so the `DevProxy` binding target exists.

### Local access with `ragctl`

`ragctl` (`cli/ragctl.ts`, run via `npm run ragctl -- <args>`) is a laptop helper for the dev-proxy. It runs on Node (not workerd) and acquires a Cloudflare Access token via `cloudflared`, then issues typed commands through `packages/devproxy-client`. Because the dev-proxy now also requires a Better Auth (Discord) session — established in the browser — a CLI caller must supply that session cookie via `RAGCTL_SESSION_COOKIE` (copy the `better-auth.session_token` cookie from a logged-in browser); the browser UI is the primary interface.

```sh
npm run ragctl -- login             # Cloudflare Access SSO via cloudflared
export RAGCTL_SESSION_COOKIE="better-auth.session_token=…"   # from a logged-in browser
npm run ragctl -- cmd ragboard      # run a command through the dev-proxy
npm run ragctl -- cmd ask --opt prompt="what is a rag?"
```

**Commands.** `login [--refresh]` (browser SSO via `cloudflared`; `--refresh` re-fetches the token without re-authenticating) and `whoami` (decodes the cached token's claims); `discover` (lists the dev-proxy operations straight from `workers/applications/dev-proxy/api/middleware_client/openapi.yaml`, so it works offline and never drifts from the typed client); `cmd <name> [--opt k=v …] [--channel <id>] [--json]` (the typed call); and `config` (shows the resolved config and where each value came from). Requires `cloudflared` on `PATH` for `login` (macOS: `brew install cloudflared`).

**Where secrets live and how they're protected.** Everything `ragctl` persists lives under one home directory — `$RAGCTL_HOME`, else `$XDG_CONFIG_HOME/ragctl`, else `~/.config/ragctl` — created `0700`:

- `access-token.json` (`0600`) — the Cloudflare Access application JWT as returned by `cloudflared`, cached with its expiry. `ragctl` never mints or verifies it (the worker re-verifies every call); `whoami` only decodes it for display.
- `config.json` — optional `{ "baseUrl", "accessUrl" }` overrides.

The home defaults outside the repo; a repo-local `.ragctl/` is also gitignored in case `RAGCTL_HOME` is pointed inside the tree.

**Config precedence** is flag > env (`RAGCTL_BASE_URL`, `RAGCTL_ACCESS_URL`) > `config.json` > default (`https://ragbot-dev.jsmunro.me`). `accessUrl` (the Access application `cloudflared` authenticates against) defaults to `baseUrl`. The acting Discord subject is **not** a `ragctl` setting: it is the authenticated Discord session, bounded by the gateway allowlist, never caller-supplied.

## Local and Deploy Commands

`./deploy.sh`

`npm run dev:all` runs the Discord worker, the workflows worker, the responder worker, and the spend worker locally.

`npm run deploy` deploys all workers (responder first, so the workflows worker's service binding target exists). Use `npm run deploy:main`, `npm run deploy:workflows`, `npm run deploy:responder`, or `npm run deploy:spend` to deploy one worker.

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

The workflows worker's AI config KV namespace must exist and its id filled into `workers/services/workflows/wrangler.jsonc` (the committed `id` is a placeholder):

```sh
wrangler kv namespace create AI_CONFIG
# paste the printed id into workers/services/workflows/wrangler.jsonc, then:
npm run config:push
```

`config:push` is idempotent and also runs from `deploy.sh` after every deploy, so the namespace stays in sync with the checked-in files.

Every dead-letter queue has a consumer (`packages/domain/dlq.ts`): `ai-jobs-dlq` in the workflows worker, `ai-spend-jobs-dlq` in the spend worker, and `discord-outbox-dlq` in the responder. Each logs a `dead_letter_message` error with the queue name, message id, attempt count, and decoded envelope kind (ids and kinds only, never free-text content), then acks so dead letters surface in logs instead of accumulating.
