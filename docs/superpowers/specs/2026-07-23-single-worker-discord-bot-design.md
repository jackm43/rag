# Single-worker Discord bot design

Date: 2026-07-23 · Branch: `simplify`

## Goal

Collapse the six-worker platform back to its core: **one Cloudflare Worker**
that is a Discord bot. It accepts slash commands (HTTP interactions) and chats
when @-mentioned (gateway websocket). Everything not required for that is
removed from the repo. No deployed data is deleted.

## What stays, what goes

**Keep (the bot):**
- All 10 slash commands: `/rag`, `/ragboard`, `/ragspend`, `/ragspendboard`,
  `/raghammer`, `/ragunban`, `/undorag`, `/ask`, `/bicture`, `/ragjam`.
- @-mention chat (gateway websocket, MESSAGE_CONTENT intent).
- Discord Ed25519 verification of incoming interactions (tweetnacl, 5-min skew).
- D1 `ragbot` (id `5833b0bb-7806-483e-9015-32e209ce2fb0`) — all tables, bound
  as `DB`. Untouched.
- KV `AI_CONFIG` (id `2a6dbd44…`) for AI prompts/config, with the bundled
  fallbacks kept.
- The `DiscordGateway` Durable Object, staying in worker `ragbot-worker`
  (its current home — no DO class migration needed; existing migration tag kept).
- In-process AI spend estimation writes (the `/ragspend*` commands keep working).
- Cron `*/15 * * * *` + watchdog alarm to self-heal the websocket.
- Guild allow-list (`ALLOWED_GUILD_IDS`) and admin allow-list.

**Drop (platform machinery):**
- Apps `auth`, `webhooks`, `responder`, `spend`, `workflows` — folded in-process
  or deleted from the repo. Deployed workers are left running untouched
  (decommissioning is a later, explicit step).
- All Queues (`ai-jobs`, `discord-outbox`, `webhook-jobs`, `ai-spend-jobs` +
  DLQs) — replaced by direct in-process calls under `waitUntil`.
- `InteractionSession` and `WebhookDedupe` DOs — interaction work runs via
  `waitUntil` from the fetch handler; gateway-message dedupe moves into the
  `DiscordGateway` DO's own storage (recent message-id set, TTL-pruned).
- Packages `edge-kit`, `queue-kit`, `secrets`, most of `auth-kit`,
  capnp envelope framing in `contracts-core`. Better Auth, Cedar remnants,
  webhook HMAC, CF Access. React/vite/dashboard deps.
- AI Gateway spend *reconciliation* (the spend worker). Estimates are kept;
  reconciliation can return later if wanted.
- The pnpm workspace itself: single package, single `wrangler.jsonc`.

## Architecture

One worker, name **`ragbot-worker`** (unchanged, so the DO stays put and the
`ragbot.jsmunro.me` custom domain carries over).

```
src/
  index.ts            fetch: POST /interactions (Ed25519 → ack ≤3s → waitUntil)
                      scheduled: cron → ensure gateway connected
  structs/            evobot-style core classes
    gateway.ts        DiscordGateway DO (websocket, heartbeat, resume, watchdog)
    command.ts        Command interface: { data, kind, adminOnly?, execute }
    registry.ts       loads commands/, dispatches interactions, authz/ban checks
  commands/           one file per command, evobot pattern
    rag.ts ragboard.ts ragspend.ts ragspendboard.ts raghammer.ts
    ragunban.ts undorag.ts ask.ts bicture.ts ragjam.ts
  events/
    messageCreate.ts  @-mention detection + reply job (from domain/mention.ts)
  lib/
    discord.ts        REST client (from packages/discord/api)
    ai/               inference client, config (KV + bundled), spend estimate
    db.ts             D1 helpers (bans, totals, threads, conversation)
    verify.ts         Ed25519 (from auth-kit/discord.ts)
    logger.ts
migrations/           unchanged (D1 ragbot)
scripts/
  register-commands.ts  derives payload from src/commands/* (single source of truth)
test/                 vitest-pool-workers, ported for the surviving surface
wrangler.jsonc        DO DISCORD_GATEWAY, D1 DB, KV AI_CONFIG, AI binding,
                      cron, route ragbot.jsmunro.me
```

### Request flows

- **Slash command:** Discord → `POST ragbot.jsmunro.me/interactions` → verify
  Ed25519 against `DISCORD_PUBLIC_KEY` → PING→PONG, else deferred ack (type 5)
  → `ctx.waitUntil(execute(...))` → edit the original response via Discord REST
  (media uploads included, no 128 KiB queue cap anymore).
- **Mention:** gateway MESSAGE_CREATE in the DO → filter (bots, guilds, empty)
  → dedupe against DO storage → build reply job (thread lookup, bans, limits)
  → run AI chat → post reply via REST, all inside the DO with `waitUntil`.
- **Secrets:** plain worker secrets — `DISCORD_BOT_TOKEN`,
  `DISCORD_PUBLIC_KEY`, `GATEWAY_CONTROL_TOKEN`, `CF_AIG_TOKEN`.
  Operator start/stop/health routes stay, gated by `GATEWAY_CONTROL_TOKEN`.

### Cutover

1. Deploy the collapsed `ragbot-worker` (replaces the old gateway worker
   in place; DO carries over, or reconnects fresh — its state is transient).
2. Register commands (guild `457689460096630794`).
3. Point the Discord application's `interactions_endpoint_url` at
   `https://ragbot.jsmunro.me/interactions` (Discord verifies with a PING).
4. Old workers keep running but stop receiving traffic; queues drain to
   nothing. Nothing is deleted.

## Error handling

- Interaction execute failures edit the deferred response with a friendly
  error; errors logged structured (logger kept).
- Websocket: existing resume/reconnect/invalid-session logic ported verbatim;
  watchdog alarm + cron as belt-and-braces.
- AI failures on mentions: log and post a short apology reply (current
  behavior preserved).

## Testing

`pnpm run check` (tsc) and `pnpm test` (vitest-pool-workers) must pass.
Port existing tests for: Ed25519 verification, command dispatch/authz/bans,
mention detection/dedupe, D1 command handlers. Delete platform tests.
