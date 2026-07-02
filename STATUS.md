# Project Status & Design

Branch: `feature/security-architecture` (45 commits ahead of `main`).
Working tree clean. `npm run check` clean, 192 tests passing (19 files).

This document is the running state of the security + architecture rework started from
`RECOMMENDATIONS.md`. It records what is built, what remains, the design decisions taken
along the way, and the open questions. Read `RECOMMENDATIONS.md` for the original findings
and `README.md` for operator-facing setup.

> **Working preference:** remaining work is being done **without adding tests** (per
> instruction). The existing 192 tests stay green as a regression floor; new commits
> should not remove or weaken them, but need not add new ones unless asked.

---

## Where we are

The codebase went from a single Cloudflare Worker doing everything to a **four-worker,
event-driven system split along trust boundaries**, with cryptographic identity
propagation, centralized policy, and per-identity egress control. It is deployable today
(pending the operator bootstrap steps in the checklist below).

### Runtime shape

```
Discord ──signed interaction──▶ gateway (public)
                                  │  verify sig, Cedar authz, mint origin identity ctx
                                  ▼
                              ai-jobs queue ──▶ brain (no public route)
                                                 │ AI calls, D1, verify+re-mint identity
                                                 ├──▶ discord-outbox queue ──▶ responder ──▶ Discord REST (writes)
                                                 ├──▶ binding RPC (media) ────▶ responder
                                                 └──▶ ai-spend-jobs queue ───▶ spend ──▶ CF AI Gateway logs
DiscordGateway DO (in gateway worker): websocket → validate → encode → enqueue only
```

### Workers (each its own identity, config, thin entrypoint)

| Worker | Folder | Role | Public route | Secrets it holds |
|---|---|---|---|---|
| `ragbot-worker` (gateway) | `workers/public/gateway` | Interaction webhook + gateway-control HTTP + hosts the `DiscordGateway` DO | **yes** (`ragbot.jsmunro.me`) | `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` (DO IDENTIFY + interaction webhook edits), `GATEWAY_CONTROL_TOKEN`, `GATEWAY_SIGNING_KEY` |
| `ragbot-brain-worker` | `workers/services/brain` | All AI work, D1, conversation building | no | `CF_AIG_TOKEN`, `DISCORD_BOT_TOKEN` (read-only REST + thread create), `BRAIN_SIGNING_KEY` |
| `ragbot-responder-worker` | `workers/services/responder` | **Sole** Discord write egress + final output policy | no | `DISCORD_BOT_TOKEN` (only writer) |
| `ragbot-spend-worker` | `workers/services/spend` | AI Gateway spend reconciliation | no | `CLOUDFLARE_API_TOKEN` (scope to AI Gateway Read) |

### Packages (shared, no build step, relative imports)

- `packages/contracts` — Cap'n Proto event envelope + generated code (`npm run contracts:build`), value-constraint validation (snowflake regex, length caps), typed encode/decode. Also holds `types.ts`/`validation.ts`.
- `packages/boundaries/{inbound,outbound,peer}` — the trust-boundary taxonomy:
  - **inbound** — `InboundGuard` objects (Discord Ed25519 signature guard, operator control-token guard) yielding typed principals or typed denials.
  - **outbound** — per-identity egress HTTP clients (host allowlist, credential injection, timeout, size cap, path-redaction for token-bearing identities).
  - **peer** — worker↔worker hops (queue + binding RPC), identity-token mint/verify, Cedar authorize seam.
- `packages/authz` — **Cedar** policy engine (`@cedar-policy/cedar-wasm`), `.cedar` policy files, admin-group entity data, `authorize({principal, action, resource, context})`.
- `packages/identity` — signed **identity-context tokens** (Ed25519 JWS): mint/verify, per-worker keypairs, committed public keyring, `scripts/generate-keys.ts`.
- `packages/ai` — model clients, tracked completions (spend recording), ask-mode heuristic, config loader (KV-backed with bundled fallback), `ai-config/` prompt files.
- `packages/discord` — Discord REST module (built on the outbound boundary client).
- `packages/domain` — business logic: command registry + specs, conversation/thread building, consumer processors, limits, bans, guild allowlist, DLQ handlers, responder output policy.
- `packages/logger` — structured logging + trimmed error detail.

### Security properties now true in code

- Public entrypoint holds no AI credential; each worker holds only the secrets for its job.
- Every worker↔worker hop carries a short-lived (~60s) Ed25519-signed identity token bound to a hash of the message bytes; receivers verify signature/issuer/audience/expiry/payload-hash **before** Cedar authorization, which runs **before** any handler.
- Trust-zone transitions re-mint on-behalf-of the original `sub` (RFC 8693-style actor chain); unauthorized peer-client construction fails closed at build time.
- All outbound HTTP goes through host-allowlisted, credential-injecting boundary clients; token-bearing paths are redacted from logs.
- Authorization is centralized in Cedar policies (admins, bans, operator control, peer hops) — no scattered `isAdmin` / ban checks.
- Abuse controls are attacker-focused: per-user burst limit (flood detection) + **global** daily $ budget backstop; guild allowlist fail-closed at both ingresses; bans cover AI commands.

---

## Completed work (by task)

1. ✅ **Phase 1 quick wins** — tests in CI, pinned action SHAs + Dependabot, dedicated `GATEWAY_CONTROL_TOKEN`, media download size cap + timeout.
2. ✅ **Abuse controls** — later refocused (see task 7) from per-user quotas to attacker-focused burst + global budget.
3. ✅ **Phase 2 cleanups** — dead code removal, duplication consolidation, deferred-response helper, tracked-completion consolidation, unified Discord REST helpers, command handler map, `discord.js` → devDeps.
4. ✅ **Module splits** — `mention.ts` → threads/conversation/consumer; test suite split.
5. ✅ **Contracts + queue** — Cap'n Proto envelopes for all queue messages, `/ask` moved onto the queue (immediate thread link, prompt-derived title, one fewer paid model call), `RETURNING` in rag commands.
6. ✅ **Trust-zone split** — `/bicture` onto queue, brain worker, responder worker + `discord-outbox` + media RPC, thinned DO.
7. ✅ **Hardening tail** — attacker-focused limits, guild allowlist, ban coverage for AI, D1 migrations, DLQ consumers, `/gateway/stop`, embed suppression for uncited URLs, trimmed error logs, logged failed interaction edits, removed prod `preview_database_id`.
8. ✅ **Boundary HTTP client** — per-identity egress policy; all outbound HTTP migrated onto it.
10. ✅ **Repo restructure** — `workers/` by layer + `packages/`; thin entrypoints; declarative command-spec registry.
11. ✅ **Cedar authz** — policy engine package; `authorize()` at command pre-flight, operator control, and peer boundaries; `admins.ts` replaced by policy data.
15. ✅ **Boundary taxonomy** — `net/` reorganized into inbound/outbound/peer with uniform `{identity, trustZone, policy, context}`; webhook path-redaction leak fixed.
16. ✅ **Prompts to KV** — `AI_CONFIG` KV binding on brain with bundled fallback; `config:push` deploy step.
17. ✅ **Identity-context token exchange** — Ed25519 signed tokens minted at ingress, re-minted on-behalf-of at each hop, verified before Cedar; construction-time authorization; bindings documented as the platform-guaranteed transport-identity (mTLS-equivalent) layer.

---

## Remaining work (not started / interrupted)

### Task 12 — Service manifests + generated clients/servers *(interrupted; reverted to pending)*
**Goal (refined per user):** a service = a collection of registered operations (RPCs), each
with its own request/response types **co-located with the owning service**; `packages/contracts`
becomes the higher-level layer that enforces the service registry (only registered operations
are invokable) rather than enumerating every payload. Generate, from the manifests:
- typed **clients** (`createServiceClient(service, transport)` uniform factory → per-service typed facades over the peer boundary), and
- **server dispatchers** that verify identity token → confirm the operation is registered for that service → run Cedar authz for the op's action → validate the typed request → call the hand-written handler. Unregistered/unauthorized ops never reach a handler.

Planned as 4 commits: (1) per-service operation manifests, (2) co-locate request types /
split the `.capnp` per service, (3) generate typed clients + server dispatchers (textual
codegen **or** a manifest-driven runtime achieving the same type-safety + single interface —
either acceptable), (4) make the contract refuse unregistered `(service, operation)` pairs.
This underpins the dev-proxy work, so it should land first.

### Task 9 — OpenAPI spec + generated types for the public surface *(pending)*
`openapi.yaml` covering the gateway public routes **and** the future dev-proxy API, with
`securitySchemes` for the control-token bearer, Discord signature headers, and CF Access
JWT + DPoP. `openapi-typescript`-generated types plus a typed app-client wrapper (token/DPoP
middleware hooks) consumed by the dev-proxy web UI and `ragctl`. Convention: **proto (capnp)
for service↔service, OpenAPI/zod for public/app-facing surfaces.**

### Task 13 — `ragbot-dev-proxy` *(pending, depends on 12 + 9)*
A "development application that runs in prod" so there is never a separate dev client/data:
- `workers/public/dev-proxy` — public web app worker. Verifies **CF Access JWT** (JWKS), implements **DPoP** for the browser client (WebCrypto keypair, `jkt`-bound session, `jti` replay cache), minimal web UI.
- Mints an ES256 **application-bound assertion** carrying `{app, user/sub, session, jkt}` identity context and calls the ragbot public API **over a service binding** (never a public hop) — so the app↔app auth can only be invoked by the dev-proxy.
- The ragbot authz library verifies **all three**: client credentials (the binding + app assertion), the app identity, and the user/session context, through Cedar, before entering the normal authorized handler.
- Uses OpenAPI/zod at ingress and capnp on the binding, consuming the generated artifacts from tasks 9 + 12.

### Task 14 — `ragctl` local CLI *(pending, depends on 9/13)*
Node CLI using the generated OpenAPI client: local keypair/DPoP management, `cloudflared`
Access token acquisition, endpoint discovery from `openapi.yaml`, ergonomic typed calls to
the dev-proxy API from a laptop.

### Deferred idea (captured, not scheduled)
- **Generated app-client servers (middleware) for frontend integrations** — per the user's
  "separation of duties at every point" ask: frontend integrations get generated app-client
  servers, services get generated clients+servers from the proto interfaces, nothing trusted
  implicitly. Overlaps heavily with tasks 12–13; fold in when those land.

### Explicitly out of scope (per user)
- **No retention/cleanup/deletion of interaction or prompt data.** The `rag_ai_interactions`
  / `rag_ai_threads` rows are kept indefinitely by decision.

---

## Key design decisions & known deviations

- **Bindings as mTLS-equivalent.** Literal mTLS is not implemented and not applicable to
  Cloudflare service bindings (in-process, isolate-to-isolate; the platform guarantees a
  binding is only invokable by a worker configured with it). The signed identity token
  layers *application* identity (on-behalf-of `sub` + explicit, testable verifier) on top.
  Documented in `packages/identity/token.ts`, `peer.ts`, and README.
- **DO stays in the gateway worker.** Moving a Durable Object class between scripts needs a
  risky transfer migration; deliberately deferred (deviation from RECOMMENDATIONS §1). The
  DO is already thinned to validate→encode→enqueue.
- **Bot token still in brain** for Discord **reads** (conversation context, thread creation);
  only the responder **writes**. Documented honestly rather than hidden.
- **Actor chain (`act`) depth:** `sub` attribution is preserved across all hops and bound to
  the envelope hash; the full `[gateway, brain]` chain is not threaded through brain's deep
  call graph (brain-originated egress carries `[brain]`). Bounded, documented.
- **D1 migrations: 0001-only, legacy insert shim kept.** Prod's `rag_ai_interactions` column
  shape is unverifiable from here and SQLite lacks `ADD COLUMN IF NOT EXISTS`; a blind ALTER
  could strand deploys. The dual-INSERT fallback in `consumer.ts` stays until an operator runs
  `PRAGMA table_info(rag_ai_interactions)` and confirms — documented at the shim and in the
  migration header.
- **KV config cache is per-isolate-forever.** A prompt edit needs `config:push` + isolate
  recycle (or redeploy) to take effect. Bundled imports are the fallback so a fresh/empty
  namespace never bricks.
- **Cedar bundle size:** ~1.44 MB compressed added per worker (well under the 10 MB paid-plan
  limit). `cedar-wasm` verified working under workerd and the wrangler bundler.
- **Guild allowlist when unset:** warns once per isolate and allows, so existing deploys don't
  brick before `ALLOWED_GUILD_IDS` is set; fail-closed once set. DMs denied by default.

---

## Operator bootstrap checklist (before first deploy of this branch)

These are new since `main` and are **not** automated. See README for exact commands.

- [ ] `wrangler secret put GATEWAY_CONTROL_TOKEN` (gateway) + add the `op://` field to `.env`.
- [ ] `wrangler secret put GATEWAY_SIGNING_KEY` (gateway) and `BRAIN_SIGNING_KEY` (brain) — generate with `scripts/generate-keys.ts`; commit the **public** halves to the keyring only.
- [ ] `wrangler kv namespace create AI_CONFIG`; put the id in `workers/services/brain/wrangler.jsonc`; run `npm run config:push`.
- [ ] `wrangler queues create` for all queues incl. DLQs (`ai-jobs`, `ai-jobs-dlq`, `discord-outbox`, `discord-outbox-dlq`, `ai-spend-jobs`, `ai-spend-jobs-dlq`).
- [ ] Set `ALLOWED_GUILD_IDS` var on gateway + brain.
- [ ] Confirm `CLOUDFLARE_API_TOKEN` is scoped to **AI Gateway Read** and set on the spend worker only.
- [ ] `wrangler d1 migrations apply` (0001). Keep the insert shim until columns are verified.
- [ ] Deploy order matters: responder before brain (brain's service binding target must exist). `npm run deploy` / `deploy.sh` handle this.

---

## Suggested next session order

1. **Task 12** (service manifests + generated clients/servers) — foundational for the rest; land it in the 4 planned commits.
2. **Task 9** (OpenAPI + generated public types) — needed by dev-proxy and ragctl.
3. **Task 13** (dev-proxy: CF Access + DPoP + app assertion over binding).
4. **Task 14** (`ragctl`).
5. Revisit the deferred "generated app-client servers" idea once 12–13 exist.
