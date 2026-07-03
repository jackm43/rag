# Project Status & Design

Branch: `feature/security-architecture` (60 commits ahead of `main`, plus the
uncommitted webhook-ingress + admin-surface-completion work).
`npm run check` clean, 241 tests passing (27 files). All workers (gateway,
dev-proxy, webhooks, workflows, responder, spend, connectors, registry) build under
`wrangler deploy --dry-run`.

This document is the running state of the security + architecture rework started from
`RECOMMENDATIONS.md`. It records what is built, what remains, the design decisions taken
along the way, and the open questions. Read `RECOMMENDATIONS.md` for the original findings
and `README.md` for operator-facing setup.

> **Working preference:** ordinary work is done **without adding tests** (per
> instruction). The existing tests stay green as a regression floor; new commits
> should not remove or weaken them, but need not add new ones unless asked.
> **Exception:** the dev-proxy's security-critical CF Access JWT verifier has
> focused unit tests — a test is the only way to prove that gate fails closed.
> (The dev-proxy's DPoP proof/replay verifiers and their ~10 tests were removed
> when DPoP was dropped in favour of a Better Auth Discord session; see below.)

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
                              ai-jobs queue ──▶ workflows (no public route)
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
| `ragbot-workflows-worker` | `workers/services/workflows` | All AI work, D1, conversation building | no | `CF_AIG_TOKEN`, `DISCORD_BOT_TOKEN` (read-only REST + thread create), `WORKFLOWS_SIGNING_KEY` |
| `ragbot-responder-worker` | `workers/services/responder` | **Sole** Discord write egress + final output policy | no | `DISCORD_BOT_TOKEN` (only writer) |
| `ragbot-spend-worker` | `workers/services/spend` | AI Gateway spend reconciliation | no | `CLOUDFLARE_API_TOKEN` (scope to AI Gateway Read) |
| `ragbot-webhooks-worker` | `workers/public/webhooks` | Centralised inbound-webhook ingress: `POST /{provider}/{id}`, broker-side signature verify (`webhook_verify`), event-id dedupe DO, enqueue-only onto `webhook-jobs` → workflows | **yes** (`webhooks.jsmunro.me`, deliberately NOT behind CF Access) | `WEBHOOKS_SIGNING_KEY` |
| `ragbot-connectors-worker` | `workers/services/connectors` | The credential broker (see `CONNECTORS.md`) | no | provider credentials (`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `DISCORD_OAUTH_CLIENT_ID`/`_SECRET`), secrets-backend env |

### Packages (shared, no build step, relative imports)

- `packages/contracts` — Cap'n Proto event envelope + generated code (`npm run contracts:build`), value-constraint validation (snowflake regex, length caps), typed encode/decode. Also holds `types.ts`/`validation.ts`.
- `packages/auth` — the **centralised auth service client library**: RFC-named identity vocabulary (`MachinePrincipal`, `Subject`, delegation chain, `Target`, trust zones untrusted→edge→application→trusted), `serviceClients(env)`/`createServiceClient` factory (Cedar exchange check, signing keys, token minting, transport selection, denial logging), `createServiceServer` receive pipeline yielding `ServiceRequest` (verified `RequestContext` + payload), service manifests + registry client, and `createQueueWorker(manifest, handlers)` — the shared queue-consumer shell for the service workers (register manifest before any message; unknown queue → log + ack, never wedge), so each worker's index.ts is just its manifest plus a queue→handler routing table.
- `packages/boundaries/{inbound,outbound}` — the edge boundaries:
  - **inbound** — `InboundGuard` objects (Discord Ed25519 signature guard, operator control-token guard) yielding typed principals or typed denials at the untrusted→edge crossing.
  - **outbound** — per-identity egress HTTP clients (host allowlist, credential injection, timeout, size cap, path-redaction for token-bearing identities).
- `packages/authz` — **Cedar** policy engine (`@cedar-policy/cedar-wasm`), `.cedar` policy files, admin-group entity data, `authorize({principal, action, resource, context}, dynamicEntities)` with `Human`/`Machine` principals, `authorizeAndForward` forwarding authorizer.
- `packages/identity` — signed **identity-context tokens** (Ed25519 JWS): mint/verify, per-worker keypairs, committed public keyring, `scripts/generate-keys.ts`.
- `packages/inference` — the **centralised model-access seam**: the one place that holds the AI Gateway credential (`CF_AIG_TOKEN` via a boundary client), builds account/gateway URLs, routes binding-vs-gateway-HTTP per model, and shapes the per-transport request. `InferenceClient` (`chat`/`webSearch`/`run`), memoized `inferenceClient(env)` factory; every model call in the app leaves through it.
- `packages/ai` — ragbot's workflow layer over `packages/inference`: request parameters from config, response interpretation (text/usage/sources extraction, sanitization), tracked completions (spend recording), ask-mode heuristic, config loader (KV-backed with bundled fallback), `ai-config/` prompt files.
- `packages/discord` — Discord REST module (built on the outbound boundary client).
- `packages/domain` — business logic: command registry + specs, conversation/thread building, consumer processors, limits, bans, guild allowlist, DLQ handlers, responder output policy.
- `packages/logger` — structured logging + trimmed error detail.
- `packages/connectors` — the **credential broker** abstraction: connector strategies (`api_key`, `oauth2_client_credentials`, `oauth2_authorization_code` 3LO seam, `github_app` reference impl), the declarative connector registry, the DO-backed grant + encrypted 3LO token stores, the per-isolate access-token cache, and `handleConnectorInvoke` (the authn+authz gate). Hosted by `ragbot-connectors-worker` (`workers/services/connectors`) — no route/queue, reachable only over the `CONNECTORS` service binding. Uniform **phantom-token** model: `grant` exchanges a caller's verified identity for an opaque, caller-bound handle; `authorizedFetch`/`getAccessToken`/`introspect` present the handle and the real provider credential never leaves the broker. Every op is authenticated (identity token) + Cedar-authorized (`connector.*` on `Connector::<id>`) and audit-logged with the full actor chain. Also exposes a Cedar-gated **admin surface** (`connector.admin.*`: list/describe/set-secret/providers) that never returns a secret value; `setConnectorSecret` persists a `{provider, ref}` override in the broker config store and honestly surfaces each backend's runtime write capability (vault/1Password `written`; cloudflare-secret-store `provision_required`; wrangler-env `rejected`). The workflows worker is the credential caller (`workflowsToConnectors`, not yet bound); the **dev-proxy is the admin caller** — it binds `CONNECTORS` and reaches only the admin ops. See **`CONNECTORS.md`**.

### Security properties now true in code

- Public entrypoint holds no AI credential; each worker holds only the secrets for its job.
- Every worker↔worker hop carries a short-lived (~60s) Ed25519-signed identity token bound to a hash of the message bytes; receivers verify signature/issuer/audience/expiry/payload-hash **before** Cedar authorization, which runs **before** any handler.
- Every service hop re-mints on-behalf-of the original `sub` (RFC 8693-style delegation chain); an unauthorized or key-less service client fails closed on first use.
- All outbound HTTP goes through host-allowlisted, credential-injecting boundary clients; token-bearing paths are redacted from logs.
- Authorization is centralized in Cedar policies (admins, bans, operator control, service hops) — no scattered `isAdmin` / ban checks; the service-registry snapshot feeds Cedar as dynamic entities with static bootstrap permits as the fail-closed fallback.
- Abuse controls are attacker-focused: per-user burst limit (flood detection) + **global** daily $ budget backstop; guild allowlist fail-closed at both ingresses; bans cover AI commands.
- The dev-proxy (admin app that runs in prod) reaches ragbot only over a service binding to the gateway's `DevProxy` entrypoint — never a public hop. A browser request crosses CF Access (JWT verified against the team JWKS, the perimeter) and then a Better Auth Discord session (the acting subject = the session's Discord account id; the session is bound at creation to the Access identity, so it cannot be replayed cross-identity) before the dev-proxy mints an on-behalf-of token; the gateway then authorizes the app (`service.invoke`), the capability surface (`devproxy.invoke`), the acting subject (allowlist), and the per-user command (`command.*` + ban + limits) — identically to a Discord-initiated command. Better Auth is authN only; Cedar stays authZ. Both remaining crypto verifiers (Access JWT, identity token) fail closed and are unit-tested. The dev-proxy is ALSO the **connectors admin caller**: behind the same layered auth it exposes `/api/connectors/*` + `/api/secrets/providers` (an HTTP API + a UI section), minting an on-behalf-of token into the connectors broker over a `CONNECTORS` binding for the `connector.admin.*` management ops (secret values are write-only, never returned).

---

## Completed work (by task)

1. ✅ **Phase 1 quick wins** — tests in CI, pinned action SHAs + Dependabot, dedicated `GATEWAY_CONTROL_TOKEN`, media download size cap + timeout.
2. ✅ **Abuse controls** — later refocused (see task 7) from per-user quotas to attacker-focused burst + global budget.
3. ✅ **Phase 2 cleanups** — dead code removal, duplication consolidation, deferred-response helper, tracked-completion consolidation, unified Discord REST helpers, command handler map, `discord.js` → devDeps.
4. ✅ **Module splits** — `mention.ts` → threads/conversation/consumer; test suite split.
5. ✅ **Contracts + queue** — Cap'n Proto envelopes for all queue messages, `/ask` moved onto the queue (immediate thread link, prompt-derived title, one fewer paid model call), `RETURNING` in rag commands.
6. ✅ **Trust-zone split** — `/bicture` onto queue, workflows worker, responder worker + `discord-outbox` + media RPC, thinned DO.
7. ✅ **Hardening tail** — attacker-focused limits, guild allowlist, ban coverage for AI, D1 migrations, DLQ consumers, `/gateway/stop`, embed suppression for uncited URLs, trimmed error logs, logged failed interaction edits, removed prod `preview_database_id`.
8. ✅ **Boundary HTTP client** — per-identity egress policy; all outbound HTTP migrated onto it.
10. ✅ **Repo restructure** — `workers/` by layer + `packages/`; thin entrypoints; declarative command-spec registry.
11. ✅ **Cedar authz** — policy engine package; `authorize()` at command pre-flight, operator control, and service boundaries; `admins.ts` replaced by policy data.
15. ✅ **Boundary taxonomy** — `net/` reorganized into inbound/outbound/service layers with a uniform denial shape; webhook path-redaction leak fixed.
16. ✅ **Prompts to KV** — `AI_CONFIG` KV binding on workflows with bundled fallback; `config:push` deploy step.
17. ✅ **Identity-context token exchange** — Ed25519 signed tokens minted at ingress, re-minted on-behalf-of at each hop, verified before Cedar; fail-closed client authorization; bindings documented as the platform-guaranteed transport-identity (mTLS-equivalent) layer.
18. ✅ **RFC auth architecture** — identity naming standardised on RFC terms (`Human`/`Machine` principals, Subject/Delegate/Target, `service.invoke`/`service.exchange`); trust zones remodeled to untrusted→edge→application→trusted; `packages/auth` centralised service client/server library (replaces `packages/boundaries/peer`); `ServiceRegistry` Durable Object with per-worker manifests feeding Cedar dynamic entities + `authorizeAndForward` forwarding authorizer; `openapi.yaml` for the gateway public surface.
19. ✅ **Contract-defined transport + spec-constructed gateway** — service-boundary transport types moved to capnp (`service.capnp`: `ServiceMessage` queue body, `ServiceManifest`/`ManifestSnapshot` registry RPC payloads) with generated code and total decoders (legacy object wrapper tolerated for in-flight messages); the gateway router is constructed from `openapi.yaml` via a generated route table (`npm run routes:build`) mapping paths/methods/security schemes to guards and operationId handlers, failing construction on unimplemented operations. In-process vocabulary (`Principal`, `RequestContext`, zones) deliberately stays TS, and the identity token stays RFC 7515 JWS.

20. ✅ **Webhook ingress + admin-surface completion** — `ragbot-webhooks-worker` at
   `webhooks.jsmunro.me` (validate → dedupe → enqueue-only → 2xx; signature verification
   broker-side via the new `webhook_verify` op, `webhooks` machine principal + Cedar
   permits, `webhook.event` envelope, `webhook-jobs` queue + workflows consumer seam);
   dev-proxy reserved 501s implemented (`grant` = 3LO consent begin, `installations`,
   `callback` = 3LO complete); Discord 3LO wired (`discord-user`, single-use
   subject-bound OAuth state); workflows binds `CONNECTORS`. See `CONNECTORS.md`
   ("Inbound webhooks") and `DEPLOY.md` for the operator steps.

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
`workers/public/dev-proxy/openapi.yaml` (OpenAPI 3.1) with `cfAccess` + `betterAuthSession`
`securitySchemes` (updated when DPoP was dropped for a Better Auth session),
`openapi-typescript`-generated types committed to
`packages/devproxy-client/api-types.ts` (`npm run devproxy:types`, a devDependency), the
worker's zod ingress `satisfies` the generated `CommandRequest`, and a typed app-client
(`packages/devproxy-client`) with `accessToken`/`sessionCookie` middleware hooks. Convention
held: **proto (capnp) service↔service, OpenAPI/zod public/app-facing.**

### Task 13 — `ragbot-dev-proxy` ✅ *(landed; auth reworked under Task 15)*
An admin application that runs in prod, so there is never a separate dev client/data:
- `workers/public/dev-proxy` — public edge worker. **CF Access JWT** verified against the
  team JWKS (RS256/ES256; `packages/boundaries/inbound/cf-access.ts`) is the perimeter on
  every request; **Better Auth (Discord OAuth)** runs behind it for app identity (see Task
  15 for the DPoP → Better Auth rework); minimal self-contained UI with a "Sign in with
  Discord" button and the command form.
- Mints an Ed25519 identity-context token (`sub` = the acting Discord id from the session)
  bound to a `DevProxyCommandPayload` capnp envelope, and invokes the gateway's `DevProxy`
  **service-binding** entrypoint (never a public hop) as the `dev-proxy` machine principal.
- The gateway authorizes fail-closed in order: `createServiceServer` token verify + Cedar
  `service.invoke` (the app) → `DEV_PROXY_ALLOWED_SUBJECTS` acting-subject allowlist → Cedar
  `devproxy.invoke` (capability surface) → the ordinary command pre-flight (per-user
  `command.*` + ban + limits). A proxied command is authorized identically to a Discord one,
  plus the two app-level gates.
- OpenAPI/zod at ingress, capnp on the binding, reusing the generated contract layer.

### Task 14 — `ragctl` local CLI ✅ *(landed; DPoP removed under Task 15)*
Node/tsx CLI (`cli/ragctl.ts`, `npm run ragctl -- …`) that wraps `packages/devproxy-client`
to drive the deployed dev-proxy from a laptop:
- **Access token** (`login`/`whoami`): shells out to `cloudflared access login`/`token`,
  caches the application JWT (`0600`) with its expiry, and feeds it to the client's
  `accessToken` hook as `Cf-Access-Jwt-Assertion`; never mints or verifies it.
- **Better Auth session**: the dev-proxy now also requires a Discord session (established in
  the browser); a CLI caller supplies it via `RAGCTL_SESSION_COOKIE`, fed to the client's
  `sessionCookie` hook. The browser UI is the primary interface.
- **Discovery + typed calls** (`discover`/`cmd`): `discover` lists operations from the
  committed `openapi.yaml` (offline, in lockstep with the generated types); `cmd` builds a
  `CommandRequest`, attaches the token + session cookie, and surfaces the fail-closed status
  honestly (non-2xx → non-zero exit). `config` shows the resolved config + precedence
  (flag > env > file > default). The local DPoP-key commands (`keys …`) were removed with DPoP.

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
- **Bot token still in workflows** for Discord **reads** (conversation context, thread creation);
  only the responder **writes**. Documented honestly rather than hidden.
- **Actor chain (`act`) depth:** `sub` attribution is preserved across all hops and bound to
  the envelope hash; the full `[gateway, workflows]` chain is not threaded through workflows worker's deep
  call graph (workflows-originated egress carries `[workflows]`). Bounded, documented.
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
- **App identity is Better Auth (Discord OAuth) behind Access, not DPoP** *(Task 15)*. The
  perimeter (CF Access) answers "a team member?"; Better Auth answers "which Discord user?".
  The logged-in user's Discord account id is the acting subject. Better Auth is authN only —
  Cedar stays authZ. It runs on workerd with its native D1 adapter (the `AUTH_DB` binding is
  passed directly), on a standalone `ragbot-auth` database so login/session state never mingles
  with product data. DPoP (and its `DpopReplay` DO) was removed entirely.
- **Acting Discord subject comes from the session, bounded by the gateway allowlist.** The
  dev-proxy sets `subjectUserId` to the authenticated session's Discord account id (never a
  caller input, no longer a static `DEV_PROXY_SUBJECT`), and the gateway independently enforces
  `DEV_PROXY_ALLOWED_SUBJECTS` (unset ⇒ deny all) as defense in depth. The identity token's
  `sub` is now that acting Discord id (audit truth), hash-bound to the payload.
- **The session is bound to the CF Access identity that created it** (session ↔ perimeter
  binding). At session creation the verified Access `sub` is stamped onto the session row
  (`session.accessSub`, via a Better Auth `databaseHooks.session.create.before` hook that
  re-verifies the Access JWT); the command gate requires `session.accessSub` to equal the
  request's live Access `sub`, so a leaked session cookie cannot be replayed by another
  Access-authenticated team member. (A DO to isolate the Discord tokens was considered and
  declined — the tokens live server-side in `AUTH_DB` and never reach the browser.)
- **Enqueue/AI commands via dev-proxy** run the full authorized path and enqueue to the workflows worker,
  but there is no real Discord interaction, so the async Discord edit uses the real application
  id with a synthetic interaction token (a no-op at Discord). AI/D1/spend all execute and are
  observable; the browser gets the deferred acknowledgement. Inline commands round-trip fully.
  Documented limitation of testing async paths without a real interaction.

---

## Operator bootstrap checklist (before first deploy of this branch)

These are new since `main` and are **not** automated. See README for exact commands.

- [ ] `wrangler secret put GATEWAY_CONTROL_TOKEN` (gateway) + add the `op://` field to `.env`.
- [ ] `wrangler secret put GATEWAY_SIGNING_KEY` (gateway) and `WORKFLOWS_SIGNING_KEY` (workflows) — generate with `scripts/generate-keys.ts`; commit the **public** halves to the keyring only.
- [ ] `wrangler kv namespace create AI_CONFIG`; put the id in `workers/services/workflows/wrangler.jsonc`; run `npm run config:push`.
- [ ] `wrangler queues create` for all queues incl. DLQs (`ai-jobs`, `ai-jobs-dlq`, `discord-outbox`, `discord-outbox-dlq`, `ai-spend-jobs`, `ai-spend-jobs-dlq`).
- [ ] Set `ALLOWED_GUILD_IDS` var on gateway + workflows.
- [ ] Confirm `CLOUDFLARE_API_TOKEN` is scoped to **AI Gateway Read** and set on the spend worker only.
- [ ] `wrangler d1 migrations apply` (0001). Keep the insert shim until columns are verified.
- [ ] Deploy order matters: responder before workflows (workflows worker's service binding target must exist). `npm run deploy` / `deploy.sh` handle this.

### Dev-proxy (admin app — optional, deploy only when using it)

- [ ] `wrangler secret put DEV_PROXY_SIGNING_KEY` (dev-proxy) — generate with `scripts/generate-keys.ts dev-proxy`; the public half is already committed to the keyring.
- [ ] Register a **Discord OAuth application**; add redirect URI `https://ragbot-dev.jsmunro.me/api/auth/callback/discord`; `wrangler secret put DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `BETTER_AUTH_SECRET` (random 32+ bytes) on the dev-proxy worker.
- [ ] Apply the Better Auth schema: `wrangler d1 migrations apply ragbot-auth -c workers/public/dev-proxy/wrangler.jsonc --remote`.
- [ ] Put a **Cloudflare Access application** in front of `ragbot-dev.jsmunro.me`; set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `BETTER_AUTH_URL` (`https://ragbot-dev.jsmunro.me`), and `DEV_PROXY_GUILD` vars on the dev-proxy worker. `DEV_PROXY_SUBJECT` is no longer used.
- [ ] Keep the `DEV_PROXY_ALLOWED_SUBJECTS` allowlist var on the **gateway** worker (defense in depth). Deploy the gateway before the dev-proxy (the `DevProxy` binding target must exist).

---

## Suggested next session order

1. **Task 12 remainder** — per-operation Cedar enforcement across all hops (the manifests carry `operations`; the dev-proxy hop already gates on the `devproxy.command` operation end to end).
2. **Dev-proxy hardening** — consider a real interaction bridge so async AI-command results are observable in-browser; broaden the admin surface (other sensitive service operations) as the app grows.
4. Revisit the deferred "generated app-client servers" idea.
