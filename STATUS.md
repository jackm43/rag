# Project Status & Design

Branch: `feature/security-architecture` (60 commits ahead of `main`).
Working tree clean. `npm run check` clean, 218 tests passing (24 files). All five workers
(gateway, dev-proxy, brain, responder, spend) build under `wrangler deploy --dry-run`.

This document is the running state of the security + architecture rework started from
`RECOMMENDATIONS.md`. It records what is built, what remains, the design decisions taken
along the way, and the open questions. Read `RECOMMENDATIONS.md` for the original findings
and `README.md` for operator-facing setup.

> **Working preference:** ordinary work is done **without adding tests** (per
> instruction). The existing tests stay green as a regression floor; new commits
> should not remove or weaken them, but need not add new ones unless asked.
> **Exception:** the dev-proxy's security-critical cryptographic verifiers (CF
> Access JWT verify, DPoP proof verify + replay) added 19 focused unit tests
> (199 → 218) — a test is the only way to prove those gates fail closed.

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
- `packages/auth` — the **centralised auth service client library**: RFC-named identity vocabulary (`MachinePrincipal`, `Subject`, delegation chain, `Target`, trust zones untrusted→edge→application→trusted), `serviceClients(env)`/`createServiceClient` factory (Cedar exchange check, signing keys, token minting, transport selection, denial logging), `createServiceServer` receive pipeline yielding `ServiceRequest` (verified `RequestContext` + payload), service manifests + registry client.
- `packages/boundaries/{inbound,outbound}` — the edge boundaries:
  - **inbound** — `InboundGuard` objects (Discord Ed25519 signature guard, operator control-token guard) yielding typed principals or typed denials at the untrusted→edge crossing.
  - **outbound** — per-identity egress HTTP clients (host allowlist, credential injection, timeout, size cap, path-redaction for token-bearing identities).
- `packages/authz` — **Cedar** policy engine (`@cedar-policy/cedar-wasm`), `.cedar` policy files, admin-group entity data, `authorize({principal, action, resource, context}, dynamicEntities)` with `Human`/`Machine` principals, `authorizeAndForward` forwarding authorizer.
- `packages/identity` — signed **identity-context tokens** (Ed25519 JWS): mint/verify, per-worker keypairs, committed public keyring, `scripts/generate-keys.ts`.
- `packages/ai` — model clients, tracked completions (spend recording), ask-mode heuristic, config loader (KV-backed with bundled fallback), `ai-config/` prompt files.
- `packages/discord` — Discord REST module (built on the outbound boundary client).
- `packages/domain` — business logic: command registry + specs, conversation/thread building, consumer processors, limits, bans, guild allowlist, DLQ handlers, responder output policy.
- `packages/logger` — structured logging + trimmed error detail.

### Security properties now true in code

- Public entrypoint holds no AI credential; each worker holds only the secrets for its job.
- Every worker↔worker hop carries a short-lived (~60s) Ed25519-signed identity token bound to a hash of the message bytes; receivers verify signature/issuer/audience/expiry/payload-hash **before** Cedar authorization, which runs **before** any handler.
- Every service hop re-mints on-behalf-of the original `sub` (RFC 8693-style delegation chain); an unauthorized or key-less service client fails closed on first use.
- All outbound HTTP goes through host-allowlisted, credential-injecting boundary clients; token-bearing paths are redacted from logs.
- Authorization is centralized in Cedar policies (admins, bans, operator control, service hops) — no scattered `isAdmin` / ban checks; the service-registry snapshot feeds Cedar as dynamic entities with static bootstrap permits as the fail-closed fallback.
- Abuse controls are attacker-focused: per-user burst limit (flood detection) + **global** daily $ budget backstop; guild allowlist fail-closed at both ingresses; bans cover AI commands.
- The dev-proxy (development app that runs in prod) reaches ragbot only over a service binding to the gateway's `DevProxy` entrypoint — never a public hop. A browser request crosses CF Access (JWT verified against the team JWKS) and DPoP (sender-constrained, replay-protected per-request proof; strongly-consistent DO replay cache) before the dev-proxy mints an on-behalf-of token; the gateway then authorizes the app (`service.invoke`), the capability surface (`devproxy.invoke`), the acting subject (allowlist), and the per-user command (`command.*` + ban + limits) — identically to a Discord-initiated command. All three crypto verifiers (Access JWT, DPoP, identity token) fail closed and are unit-tested.

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
11. ✅ **Cedar authz** — policy engine package; `authorize()` at command pre-flight, operator control, and service boundaries; `admins.ts` replaced by policy data.
15. ✅ **Boundary taxonomy** — `net/` reorganized into inbound/outbound/service layers with a uniform denial shape; webhook path-redaction leak fixed.
16. ✅ **Prompts to KV** — `AI_CONFIG` KV binding on brain with bundled fallback; `config:push` deploy step.
17. ✅ **Identity-context token exchange** — Ed25519 signed tokens minted at ingress, re-minted on-behalf-of at each hop, verified before Cedar; fail-closed client authorization; bindings documented as the platform-guaranteed transport-identity (mTLS-equivalent) layer.
18. ✅ **RFC auth architecture** — identity naming standardised on RFC terms (`Human`/`Machine` principals, Subject/Delegate/Target, `service.invoke`/`service.exchange`); trust zones remodeled to untrusted→edge→application→trusted; `packages/auth` centralised service client/server library (replaces `packages/boundaries/peer`); `ServiceRegistry` Durable Object with per-worker manifests feeding Cedar dynamic entities + `authorizeAndForward` forwarding authorizer; `openapi.yaml` for the gateway public surface.
19. ✅ **Contract-defined transport + spec-constructed gateway** — service-boundary transport types moved to capnp (`service.capnp`: `ServiceMessage` queue body, `ServiceManifest`/`ManifestSnapshot` registry RPC payloads) with generated code and total decoders (legacy object wrapper tolerated for in-flight messages); the gateway router is constructed from `openapi.yaml` via a generated route table (`npm run routes:build`) mapping paths/methods/security schemes to guards and operationId handlers, failing construction on unimplemented operations. In-process vocabulary (`Principal`, `RequestContext`, zones) deliberately stays TS, and the identity token stays RFC 7515 JWS.

---

## Remaining work (not started / interrupted)

### Task 12 — Service manifests + generated clients/servers *(partially landed via task 18)*
**Landed:** per-service manifests (`workers/*/src/manifest.ts`), runtime service registration
(`ServiceRegistry` DO + `ensureRegistered`), the uniform `createServiceClient`/`serviceClients`
factory and `createServiceServer` dispatcher (verify token → forwarding authorizer → decode →
handler), and registry-driven Cedar policy (`invoke-registered`/`exchange-registered`).
**Remaining:** per-operation enforcement — the manifests carry `operations` but Cedar does not
yet evaluate per envelope kind; co-locating request types / splitting the `.capnp` per service;
refusing unregistered `(service, operation)` pairs at the contract layer.

### Task 9 — OpenAPI spec + generated types for the public surface ✅ *(landed)*
**Landed:** `workers/public/gateway/openapi.yaml` for the gateway routes; and now
`workers/public/dev-proxy/openapi.yaml` (OpenAPI 3.1) with `cfAccess` + `dpop`
`securitySchemes`, `openapi-typescript`-generated types committed to
`packages/devproxy-client/api-types.ts` (`npm run devproxy:types`, a devDependency), the
worker's zod ingress `satisfies` the generated `CommandRequest`, and a typed app-client
(`packages/devproxy-client`) with `dpopProof`/`accessToken` middleware hooks + a WebCrypto
`createDpopSigner`, ready for `ragctl`. Convention held: **proto (capnp) service↔service,
OpenAPI/zod public/app-facing.**

### Task 13 — `ragbot-dev-proxy` ✅ *(landed)*
A development application that runs in prod, so there is never a separate dev client/data:
- `workers/public/dev-proxy` — public edge worker. **CF Access JWT** verified against the
  team JWKS (RS256/ES256; `packages/boundaries/inbound/cf-access.ts`); **DPoP** per-request
  proof verified (ES256, htm/htu/iat, `jkt` binding) with `jti` replay in the strongly-
  consistent `DpopReplay` Durable Object (chosen over KV for atomic check-and-record);
  minimal self-contained UI that generates the browser keypair and signs proofs.
- Mints an Ed25519 identity-context token (`sub` = the Access user; `dpopJkt` + `sid`
  session claims) bound to a `DevProxyCommandPayload` capnp envelope, and invokes the
  gateway's `DevProxy` **service-binding** entrypoint (never a public hop) as the new
  `dev-proxy` machine principal.
- The gateway authorizes fail-closed in order: `createServiceServer` token verify + Cedar
  `service.invoke` (the app) → `DEV_PROXY_ALLOWED_SUBJECTS` acting-subject allowlist → Cedar
  `devproxy.invoke` (capability surface) → the ordinary command pre-flight (per-user
  `command.*` + ban + limits). A proxied command is authorized identically to a Discord one,
  plus the two app-level gates.
- OpenAPI/zod at ingress, capnp on the binding, reusing the generated contract layer.

### Task 14 — `ragctl` local CLI ✅ *(landed)*
Node/tsx CLI (`cli/ragctl.ts`, `npm run ragctl -- …`) that wraps `packages/devproxy-client`
to drive the deployed dev-proxy from a laptop:
- **Local DPoP key** (`keys generate`/`show`): an ES256 (P-256) keypair persisted as a `0600`
  JWK under a `0700` home (`$RAGCTL_HOME` → `$XDG_CONFIG_HOME/ragctl` → `~/.config/ragctl`).
  The private half is never printed and is imported non-extractable when loaded; `loadSigner`
  wires it into `createDpopSigner`, and jkt is computed with the worker's own `ecThumbprint`.
- **Access token** (`login`/`whoami`): shells out to `cloudflared access login`/`token`,
  caches the application JWT (`0600`) with its expiry, and feeds it to the client's
  `accessToken` hook as `Cf-Access-Jwt-Assertion`; never mints or verifies it.
- **Discovery + typed calls** (`discover`/`cmd`): `discover` lists operations from the
  committed `openapi.yaml` (offline, in lockstep with the generated types); `cmd` builds a
  `CommandRequest`, attaches a fresh DPoP proof + the token, and surfaces the fail-closed
  status honestly (non-2xx → non-zero exit). `config` shows the resolved config + precedence
  (flag > env > file > default).
- Verified locally: `keys`/`config`/`discover`/`whoami` run under tsx; generated proofs pass
  the worker's real `verifyDpopProof` (jkt match, replay + htm binding enforced); and `cmd`
  sends the correct headers/body to a mock speaking the worker verifier. `login` + live `cmd`
  need the deployed dev-proxy + `cloudflared`. No new deps (reuses the repo's `yaml`); no new
  tests (local dev tool).

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
  Documented in `packages/identity/token.ts`, `packages/auth`, and README.
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
- **Dev-proxy ingress = new `DevProxy` WorkerEntrypoint on the gateway, not a new HTTP route.**
  The gateway's existing ingresses are HTTP guards; adding the dev-proxy as a service-binding
  RPC entrypoint (invocable only by a worker configured with the binding) means the app↔app
  auth surface is unreachable from the public internet — the recommended design, chosen over a
  third public HTTP route. It reuses `createServiceServer` verbatim, so a dev-proxy hop is
  verified + Cedar-authorized identically to every other service hop; the gateway gains its
  first registered service operation (`devproxy.command`).
- **Dev-proxy reuses the command path, does not duplicate it.** `handleDevProxyCommand` rebuilds
  a synthetic `DiscordInteraction` and calls `routeInteraction` → `executeCommand`, so per-user
  Cedar `command.*` + raghammer ban + usage limits run exactly as for Discord. Two extra
  app-level gates sit in front: the acting-subject allowlist and `devproxy.invoke`.
- **DPoP replay uses a Durable Object, not KV.** Replay protection needs an atomic
  check-and-record; a single-threaded DO gives that with no eventual-consistency window (KV's
  read-after-write is not immediate across the edge). `DpopReplay` is a single named instance
  with lazy alarm-based expiry; shard by `jkt` if volume grows. The store fails closed (treats
  every proof as seen) if the binding is absent.
- **Acting Discord subject is config, not caller-supplied trust.** The dev-proxy sets
  `subjectUserId` from `DEV_PROXY_SUBJECT`, and the gateway independently enforces
  `DEV_PROXY_ALLOWED_SUBJECTS` (unset ⇒ deny all), so a browser that passes Access still cannot
  make the proxy act as an arbitrary Discord user. The identity token's `sub` remains the
  Access-verified user (audit truth); the acting Discord id rides in the hash-bound payload.
- **DPoP proof is per-request, not a weaker cookie session.** Each command re-presents a fresh
  sender-constrained, single-use proof (stronger than a jkt-bound cookie that skips re-proofing).
  The token carries `dpopJkt` + a jkt-derived `sid` for correlation. **Scoped simplification:**
  the browser key is in-memory (non-extractable) for the tab's lifetime; persisting it to
  IndexedDB for a durable jkt-bound session is a documented future hardening.
- **Enqueue/AI commands via dev-proxy** run the full authorized path and enqueue to the brain,
  but there is no real Discord interaction, so the async Discord edit uses the real application
  id with a synthetic interaction token (a no-op at Discord). AI/D1/spend all execute and are
  observable; the browser gets the deferred acknowledgement. Inline commands round-trip fully.
  Documented limitation of testing async paths without a real interaction.

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

### Dev-proxy (new subsystem — optional, deploy only when using it)

- [ ] `wrangler secret put DEV_PROXY_SIGNING_KEY` (dev-proxy) — generate with `scripts/generate-keys.ts dev-proxy`; the public half is already committed to the keyring.
- [ ] Put a **Cloudflare Access application** in front of `ragbot-dev.jsmunro.me`; set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` vars on the dev-proxy worker.
- [ ] Set `DEV_PROXY_SUBJECT` (acting Discord id) + `DEV_PROXY_GUILD` vars on the dev-proxy worker; set the matching `DEV_PROXY_ALLOWED_SUBJECTS` var on the **gateway** worker.
- [ ] Deploy the gateway before the dev-proxy (the `DevProxy` binding target must exist). The `DpopReplay` DO ships with the dev-proxy config (migration `v1`).

---

## Suggested next session order

1. **Task 14** (`ragctl`) — now unblocked: wrap `packages/devproxy-client` (`createDevProxyClient` + `createDpopSigner`) in a CLI with local keypair storage and `cloudflared` Access token acquisition.
2. **Task 12 remainder** — per-operation Cedar enforcement across all hops (the manifests carry `operations`; the dev-proxy hop already gates on the `devproxy.command` operation end to end).
3. **Dev-proxy hardening** — persist the browser DPoP key to IndexedDB for a durable jkt-bound session; consider a real interaction bridge so async AI-command results are observable in-browser.
4. Revisit the deferred "generated app-client servers" idea.
