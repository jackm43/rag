# Working in this repo

Read the [README](README.md) first for what the system is and how to run it.
This file is the developer/agent guide: the architecture, the invariants you
must not regress, and the checklists for adding things.

Run `pnpm run check` (tsc --noEmit) and `pnpm test` before calling anything
done. Wrangler needs Node 22+. Commands that touch secrets go through
`op run --env-file=.env --`.

## Architecture

One Cloudflare Worker, `ragbot-worker` (`wrangler.jsonc`, entry `src/index.ts`).
No workspace, no other deployed workers, no internal queues — everything runs
in-process. The `DiscordGateway` Durable Object (`src/structs/gateway.ts`)
keeps the persistent Discord websocket alive and is controlled by the
operator routes; interaction handling for slash commands goes through
`/interactions` on the worker's own `fetch`.

- `src/index.ts` — the fetch handler: verifies and dispatches
  `POST /interactions`, the `GATEWAY_CONTROL_TOKEN`-gated gateway control
  routes, and `scheduled()` (AI spend reconciliation cron).
- `src/env.ts` — the `Env` interface: every binding, var, and secret the
  worker uses, in one place.
- `src/commands/` — one file per slash command, evobot-style (each exports a
  `Command`: a `SlashCommandBuilder`-style `data` plus an `execute`).
  `src/commands/index.ts` is the registry `Map`, keyed by `data.name` — the
  single source of truth both dispatch and command registration read from.
- `src/structs/` — `Command`/registry types, the slash-command builder
  (`slash-command-builder.ts`), and the `DiscordGateway` Durable Object
  (`gateway.ts`).
- `src/events/` — gateway websocket event handlers (`messageCreate.ts` →
  mention handling → AI reply).
- `src/lib/` — everything else: Discord REST client (`discord.ts`), Ed25519
  request verification (`verify.ts`), AI (`ai/`: inference client, per-feature
  config loaded from `ai/ai-config` with a KV override, spend tracking,
  reconciliation, and `ask-mode.ts`'s `runAskModeCompletion` — the one
  web-search-vs-chat router shared by `/ask` and tracked-thread replies), D1
  access (`db/`: bans, limits, threads, guilds, mention state, and
  `interactions.ts` for the shared `rag_ai_interactions` analytics row), wire
  types/validators (`contracts.ts`), logging (`logger.ts`).

- `dev/` — the local-only debugging UI (`pnpm run dev:ui`, config
  `wrangler.dev.jsonc`, launcher `scripts/dev-ui.ts`). `dev/harness.ts` drives
  `handleMessageCreate` / `dispatch` with synthetic Discord events under an
  AsyncLocalStorage fetch tap (`dev/fetch-tap.ts`) that stubs discord.com and
  records the AI Gateway exchange; `dev/ui/` is the static page. It imports from
  `src/` but nothing in `src/` may import from `dev/`, and it must never be
  deployed (no routes, `workers_dev: false`, `DEV_UI` guard).

## Trust model (do not regress)

- **External edges always verify.** This is the only authentication boundary
  in the system and must never be dropped:
  - Discord's Ed25519 signature is verified on every `POST /interactions`
    request before any command runs (`src/lib/verify.ts`).
  - The gateway control routes (`/gateway/start`, `/gateway/stop`,
    `/gateway/health`) require `Authorization: Bearer $GATEWAY_CONTROL_TOKEN`.
- Everything past those edges is one process calling its own functions —
  there is no internal signing, no service-binding RPC, no queue transport to
  trust or verify.
- **Fail closed, disclose nothing**: denials return a bare status; the reason
  is logged, never echoed. Never log request bodies, headers, tokens, or
  secrets.
- Outbound HTTP (Discord REST/media, AI Gateway, Cloudflare API for spend
  reconciliation) is a plain in-process `fetch`, credential injected at the
  call site from `env`. Hosts are fixed and known at the call site.
- D1 `ragbot` is the durable data: bans, spend, AI threads, guild config.
  Change the schema via `migrations/` only; `schema.sql` is a read-only
  mirror, never hand-edited.

## How to add things

**A new slash command:** add `src/commands/<name>.ts` exporting a `Command`
(`data` + `execute`), add it to the array in `src/commands/index.ts`. Run
`op run --env-file=.env -- pnpm run register:commands` to push the payload to
Discord (guild-scoped; see `targetGuildId` in `scripts/register-commands.ts`).

**A new gateway/mention event handler:** add it under `src/events/`, wire it
from `src/structs/gateway.ts` where the websocket dispatch happens.

**A new AI feature/config:** add its JSON (and prompt `.md` if needed) to
`src/lib/ai/ai-config/`, read it through `loadConfig` (KV-first, bundled
fallback) — don't hardcode prompts/model ids in command code.

## Key flows (mental model)

```
Discord interaction → POST /interactions → verify Ed25519 → dispatch to
        command.execute (src/commands/<name>.ts) → D1 / AI → reply/edit
Discord mention → DiscordGateway DO websocket → src/events/messageCreate →
        AI + D1 → reply
Cron → scheduled() → src/lib/ai/reconcile.ts → AI Gateway logs → D1 spend rows
```

## Testing

`pnpm test` runs vitest inside workerd (`@cloudflare/vitest-pool-workers`;
`vitest.config.ts` boots the worker from `./src/index.ts` and applies D1
migrations before each suite). Tests live flat under `test/*.test.ts` and
exercise the worker's fetch handler / command modules directly — no mocking
of internal RPC, since there isn't any.

## Gotchas

- Node 22+ for wrangler; `pnpm install`.
- D1: change schema via `migrations/` only. The AI usage guard fails open on
  D1 errors (deliberate); the Discord signature check and gateway control
  token fail closed. The cron also prunes `rag_ai_requests` (the burst-guard
  log) after a day, so that table never grows unbounded.
- Generated media (`/bicture`, `/ragjam`) is downloaded through
  `downloadMedia` in `src/lib/discord.ts`, which enforces the 25 MiB cap while
  streaming — do not replace it with a bare `fetch(...).arrayBuffer()`.
- The gateway DO treats Discord close codes 4004/4010–4014 as fatal: it
  disables itself instead of reconnecting every 5 s, and the next cron
  `ensureConnected()` (or an operator `/gateway/start`) is what retries.
- `worker-configuration.d.ts` is generated (`wrangler types`) — regenerate it
  after changing `wrangler.jsonc` bindings/vars, don't hand-edit it.
- The former multi-worker platform (a separate auth/API-Gateway worker, plus
  gateway/workflows/responder/spend workers talking over internal queues) has
  been collapsed into this single worker. Any leftover Cloudflare-side
  resources from that platform (extra Worker scripts, queues, KV namespaces)
  are decommissioned out of band, not by this repo.
