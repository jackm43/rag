# Single-Worker Discord Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the six-worker platform to one Cloudflare Worker (`ragbot-worker`) that serves slash commands over HTTP interactions and @-mention chat over a gateway websocket held in a Durable Object.

**Architecture:** Everything moves into a single root-level `src/` with an evobot-style layout (`commands/` one file per command, `structs/` for the gateway DO + command registry, `events/`, `lib/`). Queue hops become in-process calls under `waitUntil`; the `DiscordGateway` DO stays in `ragbot-worker` so no DO migration is needed. D1 `ragbot` and KV `AI_CONFIG` are preserved and re-bound.

**Tech Stack:** Cloudflare Workers (wrangler 4, workerd), TypeScript 5, tweetnacl (Ed25519), D1, KV, Durable Objects, Workers AI / AI Gateway HTTP, vitest + @cloudflare/vitest-pool-workers, discord.js (builders only, register script).

**Spec:** `docs/superpowers/specs/2026-07-23-single-worker-discord-bot-design.md` — read it first.

## Global Constraints

- Worker name stays exactly `ragbot-worker`; DO class name stays `DiscordGateway`, binding `DISCORD_GATEWAY`, existing migration tag preserved from `apps/gateway/wrangler.jsonc` (do NOT add a delete/rename migration).
- D1 `ragbot` id `5833b0bb-7806-483e-9015-32e209ce2fb0` bound as `DB`; KV `AI_CONFIG` id `2a6dbd4428b64d6982bfe628445c163a`. Never run destructive SQL; `migrations/` is untouched.
- Interactions must be acked within 3 s: verify → immediate response (PONG or type-5 deferred) → work in `ctx.waitUntil`.
- External edge always verified: Ed25519 (`timestamp + rawBody`, 5-min skew) on `/interactions`; `GATEWAY_CONTROL_TOKEN` on operator routes. No other ingress.
- Vars carried over: `DISCORD_APPLICATION_ID=1496842508251172895`, `ALLOWED_GUILD_IDS=457689460096630794`, `CF_ACCOUNT_ID`, `CF_AIG_GATEWAY_ID=platy`, admin ids from `packages/discord/commands/registry.ts` (`RAG_ADMIN_USER_IDS`). Secrets: `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `GATEWAY_CONTROL_TOKEN`, `CF_AIG_TOKEN`.
- Green gates: `pnpm run check` (tsc) and `pnpm test` after every task. Commit after every task.
- Follow evobot's discord.js idioms: each command module exports `data: new SlashCommandBuilder()…` and `execute()`; the registry holds them in a `Collection` (or Map) keyed by name like evobot's `bot.commands`; replies use `EmbedBuilder` where the old code built raw embed objects. Because the full discord.js `Client` cannot run on Workers, runtime imports come from `@discordjs/builders` and `discord-api-types/v10` (the exact classes discord.js re-exports); the gateway stays our DO.
- Port logic verbatim where possible — this is a re-homing, not a rewrite. Preserve behavior: ban checks, guild allow-list, thread conversation flow, spend-estimate writes.
- Old `apps/*` and `packages/*` stay in the tree until Task 8 removes them; new code must not import from them (copy, don't import).

---

### Task 1: Scaffold single-worker layout

**Files:**
- Create: `wrangler.jsonc` (root), `src/index.ts`, `src/lib/logger.ts`, `src/env.ts`
- Modify: `package.json` (root), `tsconfig.json`, `vitest.config.ts`
- Test: `test/index.test.ts`

**Interfaces:**
- Produces: `Env` type in `src/env.ts` with bindings `DB: D1Database`, `AI_CONFIG: KVNamespace`, `AI: Ai`, `DISCORD_GATEWAY: DurableObjectNamespace`, vars/secrets listed in Global Constraints. `logger` from `src/lib/logger.ts` (port `packages/logger/src/*` verbatim: `logger`, `errorMessage`, `errorDetails`).

- [ ] **Step 1:** Write root `wrangler.jsonc` by merging `apps/gateway/wrangler.jsonc` (name `ragbot-worker`, DO + migration tag, cron, route/custom-domain, vars, D1 `DB`) with the `AI_CONFIG` KV + `ai` bindings from `apps/workflows/wrangler.jsonc`. Drop: queues, service bindings, cross-script DOs. `main: "src/index.ts"`.
- [ ] **Step 2:** `src/env.ts` defining `Env`; `src/index.ts` exporting a fetch handler that 404s and a `scheduled` no-op, plus `export { DiscordGateway } from "./structs/gateway"` stubbed as a class extending `DurableObject` with an empty `fetch` (real port in Task 6).
- [ ] **Step 3:** Trim root `package.json`: remove workspace `@rag/*` deps, react/vite/better-auth/capnp/@1password; keep `tweetnacl`, `zod`, dev: wrangler, typescript, tsx, vitest, @cloudflare/vitest-pool-workers, discord.js (dev-only, register script). Scripts: `dev`, `deploy` (`wrangler deploy`), `check` (`tsc --noEmit`), `test`, `register:commands`, `d1:migrate:*` (point at root wrangler.jsonc). Keep `pnpm-workspace.yaml` intact for now (removed in Task 8) so the old packages still typecheck; add `src` to tsconfig `include`.
- [ ] **Step 4:** Point `vitest.config.ts` at root `wrangler.jsonc`. Write `test/index.test.ts`: unknown route returns 404. Run `pnpm install && pnpm run check && pnpm vitest run test/index.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat: scaffold single-worker layout`.

### Task 2: Ed25519 verification + interactions ingress

**Files:**
- Create: `src/lib/verify.ts`, `src/lib/http.ts`
- Modify: `src/index.ts`
- Test: `test/verify.test.ts`, `test/interactions.test.ts`

**Interfaces:**
- Consumes: `Env`, `logger`.
- Produces: `verifyDiscordSignature(publicKeyHex: string, req: Request, rawBody: string): boolean` (port `packages/auth-kit/discord.ts` incl. 5-min skew + hex validation); `handleInteraction(request, env, ctx): Promise<Response>` wired at `POST /interactions`: verify → PING(1)→PONG(1) → else type-5 deferred ack and `ctx.waitUntil(dispatch(...))` where `dispatch` is a stub until Task 5. `jsonResponse` helper in `http.ts`.

- [ ] **Step 1:** Port verification (source: `packages/auth-kit/discord.ts`, reference edge use: `apps/webhooks/src/index.ts` `handleInteractions`). Use single `DISCORD_PUBLIC_KEY` secret instead of the clientId→key map.
- [ ] **Step 2:** Port/adapt tests from existing auth-kit + webhooks tests (find with `grep -rl verifyDiscordSignature test packages`): bad signature → 401, stale timestamp → 401, PING → PONG, slash command → 200 type 5. Run → PASS.
- [ ] **Step 3:** Commit `feat: interactions endpoint with Ed25519 verification`.

### Task 3: lib — Discord REST, D1 domain, AI

**Files:**
- Create: `src/lib/discord.ts` (from `packages/discord/api/*` — REST client incl. media edits from `packages/discord/domain/responder.ts`), `src/lib/db/` (port `packages/discord/domain/`: `bans.ts`, `limits.ts`, `threads.ts`, `guilds.ts`, `conversation.ts` — keep filenames), `src/lib/ai/` (port `packages/discord/ai/`: `inference/client.ts`, `config.ts` + `ai-config/` JSON bundle, `tracked-ai.ts`, spend-estimate write path from `spend.ts` — drop the queue consumer/reconciliation half)
- Test: `test/db.test.ts`, `test/ai-config.test.ts` (port matching existing tests from `test/`)

**Interfaces:**
- Consumes: `Env`, `logger`.
- Produces: same exported function names/signatures as the source modules (verbatim port; imports rewritten from `@rag/*` to relative). Later tasks import e.g. `recordSpendEstimate`, `getAiConfig`, `discordRest`, `checkBan`.

- [ ] **Step 1:** Copy modules, rewrite imports, replace queue-producer calls (`SPEND_JOBS.send`, `DISCORD_OUTBOX.send`) with direct function calls (spend estimate → direct D1 insert; outbox send → direct REST call through `src/lib/discord.ts`).
- [ ] **Step 2:** Port the corresponding existing vitest files; `pnpm run check` + tests PASS.
- [ ] **Step 3:** Commit `feat: port discord REST, domain db, and AI libs`.

### Task 4: Command structs + all 10 commands (evobot pattern)

**Files:**
- Create: `src/structs/command.ts`, `src/structs/registry.ts`, `src/commands/{rag,ragboard,ragspend,ragspendboard,raghammer,ragunban,undorag,ask,bicture,ragjam}.ts`, `src/commands/index.ts`
- Test: `test/commands.test.ts` (port existing command tests)

**Interfaces:**
- Consumes: Task 3 libs.
- Produces: `interface Command { data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder; adminOnly?: boolean; aiLimited?: boolean; execute(ctx: CommandContext): Promise<void> }` (`SlashCommandBuilder` from `@discordjs/builders`), where `CommandContext = { interaction: APIChatInputApplicationCommandInteraction, env, ctx, editReply(msg), followUp(msg) }` (interaction types from `discord-api-types/v10`). `src/commands/index.ts` exports `commands: Map<string, Command>` keyed by `data.name`, evobot-style. `registry.ts` exports `dispatch(interaction, env, ctx)` — resolves command, runs ban/admin/guild checks (port from `packages/discord/commands/registry.ts` + `session-run.ts`), calls `execute`, edits deferred reply on error. Task 2's stub is replaced by this `dispatch`.

- [ ] **Step 1:** Build `command.ts` + `registry.ts`. Each command's `data` comes from the spec in `packages/discord/commands/specs.ts` merged with the builder definitions in `scripts/register-commands.ts` (they were duplicated; commands become the single source of truth).
- [ ] **Step 2:** Port each handler from `packages/discord/commands/<name>.ts`. Formerly-enqueued kinds (`ask`, `bicture`, `ragjam`) now run their job in-process inside `execute` (the code that lived in the workflows consumer, `packages/discord/domain/consumer.ts` / `session.ts` `run()`), still behind the type-5 deferred ack.
- [ ] **Step 3:** Port command tests (dispatch, authz, ban gating, one happy path per command with mocked AI/REST). `pnpm run check` + `pnpm test` PASS.
- [ ] **Step 4:** Commit `feat: evobot-style command registry with all ten commands`.

### Task 5: Wire dispatch into interactions route

**Files:**
- Modify: `src/index.ts` (replace Task 2 stub with `registry.dispatch`)
- Test: extend `test/interactions.test.ts` — end-to-end: signed `/ragboard` interaction → 200 type 5 → mocked REST edit called.

- [ ] **Step 1:** Wire, run full suite, PASS. Commit `feat: dispatch slash commands from interactions endpoint`.

### Task 6: Gateway DO + mention event

**Files:**
- Create: `src/structs/gateway.ts` (port `apps/gateway/src/gateway.ts` verbatim: identify/resume, heartbeat, op 7/9, watchdog alarm, start/stop flags), `src/events/messageCreate.ts` (port `packages/discord/domain/mention.ts`: `handleGatewayMessageCreate` + `resolveGatewayMessage`)
- Modify: `src/index.ts` (scheduled → `ensureGatewayConnected`; operator routes `POST /gateway/start|stop`, `GET /gateway/health` gated by `GATEWAY_CONTROL_TOKEN`, port from `apps/gateway/src/router.ts`)
- Test: `test/mention.test.ts` (port existing mention tests), `test/gateway-routes.test.ts`

**Interfaces:**
- Consumes: Task 3 libs, `events/messageCreate.ts`.
- Produces: `DiscordGateway` DO replacing the Task 1 stub. On MESSAGE_CREATE it calls `handleMessageCreate(msg, env, ctx)`; the old `INTERACTION_SESSION.runMention` hop is replaced by running the AI reply in-process under `waitUntil`, with dedupe via DO storage: `processed:<messageId>` keys, pruned by the existing watchdog alarm after 24 h (replaces `InteractionSession.claim()`).

- [ ] **Step 1:** Port DO; swap `INTERACTION_SESSION` calls for in-DO processing + storage dedupe.
- [ ] **Step 2:** Port mention tests (mention token parsing, bot/guild filters, dedupe) and operator-route auth tests. `pnpm run check` + `pnpm test` PASS.
- [ ] **Step 3:** Commit `feat: gateway DO with in-process mention handling`.

### Task 7: Command registration script from registry

**Files:**
- Modify: `scripts/register-commands.ts` — delete the duplicated builder list; import `commands` from `src/commands/index.ts` and PUT `[...commands.values()].map(c => c.data.toJSON())` as guild commands for `457689460096630794`, empty global set, unchanged REST v10 calls.
- Test: `test/register-payload.test.ts` — payload contains exactly the 10 names.

- [ ] **Step 1:** Implement, test PASS, commit `feat: derive command registration from command modules`.

### Task 8: Remove the platform

**Files:**
- Delete: `apps/`, `packages/`, `pnpm-workspace.yaml`, `scripts/{deploy.ts,scaffold.ts,generate-openapi.ts,push-config.ts,backfill-spend.ts,generate-gateway-routes.ts,check-dep-direction.ts}`, `deploy.sh`, platform tests in `test/`, `worker-configuration.d.ts` if stale
- Modify: `package.json` (drop workspace/deploy scripts; `deploy` = `wrangler deploy`), `README.md` + `AGENTS.md` (rewrite for single-worker layout; keep the trust-model line "external edges always verify"), `.env` (keep only needed op refs)

- [ ] **Step 1:** Delete, prune, rewrite docs. `pnpm install && pnpm run check && pnpm test` all green from a clean tree.
- [ ] **Step 2:** Commit `feat!: remove multi-app platform; single-worker repo`.

### Task 9: Deploy + cutover (main session, not a subagent)

- [ ] **Step 1:** `op run --env-file=.env -- pnpm wrangler deploy` (replaces old gateway worker in place). Verify `GET https://ragbot.jsmunro.me/gateway/health` with control token.
- [ ] **Step 2:** `op run --env-file=.env -- pnpm run register:commands`.
- [ ] **Step 3:** Ensure secrets exist on the worker (`wrangler secret list`; put any missing: `DISCORD_PUBLIC_KEY`, `CF_AIG_TOKEN`).
- [ ] **Step 4:** PATCH Discord `https://discord.com/api/v10/applications/@me` with `{"interactions_endpoint_url":"https://ragbot.jsmunro.me/interactions"}` (Discord sends a PING; endpoint must 200-PONG). 
- [ ] **Step 5:** `POST /gateway/start`; verify websocket connects (health shows connected). Smoke-test `/ragboard` and an @-mention in the guild if possible; otherwise verify via worker logs (`wrangler tail`).
- [ ] **Step 6:** Do NOT delete old workers, queues, D1, or KV. Commit any final tweaks; report cutover state.
