# Working in this repo

Read the [README](README.md) first for what the system is and how to run it.
This file is the developer/agent guide: the architecture, the invariants you
must not regress, and the checklists for adding things.

Run `pnpm run check` (tsc + dependency-direction check) and `pnpm test` before
calling anything done. Wrangler needs Node 22+. Commands that touch secrets go
through `op run --env-file=.env --`.

## Architecture

pnpm workspace. **One deployed worker = one top-level `apps/<worker>`
application.** Shared code lives only in `packages/*` (named `@rag/*`); apps
never import other apps. There is no product grouping and no per-worker
`api/middleware_client` + `service_server` split beyond intra-app folders.

**Apps** (each is a deployed worker):
- `apps/auth` — the **auth worker / API Gateway** (binding-only, no route). Owns
  all public-ingress authentication (Cloudflare Access, Better Auth Discord
  sessions + the `ragbot-auth` D1, operator token) and the data-driven
  authorization policy table. Every public app binds it as `AUTH`.
- `apps/gateway` — the Discord bot edge (`ragbot.jsmunro.me`): the
  `DiscordGateway` websocket Durable Object + cron, and the operator control
  routes (start/stop/health) + key-discovery docs.
- `apps/workflows` — the AI job consumer + the `InteractionSession` processor DO
  (deferred commands / mentions run to completion here). Consumes `ai-jobs` and
  `webhook-jobs`.
- `apps/responder` — Discord write policy: the `discord-outbox` queue consumer +
  the `Responder` media-edit RPC entrypoint.
- `apps/spend` — AI Gateway cost reconciliation (`ai-spend-jobs` consumer).
- `apps/webhooks` — provider-webhook + Discord-interaction ingress
  (`webhooks.jsmunro.me`); the `WebhookDedupe` DO. Provider webhooks are verified
  by the auth service (`AUTH.verifyWebhook`); Discord interactions are verified
  inline (Ed25519).

There is no egress worker: outbound HTTP happens **in-process** in the RPC method
that needs it (see `@rag/outbound`).

**Packages** (shared):
- `edge-kit` — the single shared middleware. `createAppWorker({service, routes,
  openapi, clients})` is the fetch handler for every public app: serve discovery
  (`/health`, `/openapi.json`, `/.well-known/*`), match a route, then
  **authenticate → verify → authorize** through the `AUTH` binding before
  dispatching. Ships the `web` / `native` / `webhook` client handlers, plus the
  generic `createEdgeWorker` harness for inline-signature workers (webhooks).
- `auth-kit` — the auth library: verification primitives (CF Access JWT, Better
  Auth Discord session, native/operator token, oauth2 client-credentials, Discord
  Ed25519, provider webhook HMAC) + per-client-kind strategies
  (`authenticateWeb`/`authenticateNative`) and `verifyWebhook`. Used by the auth
  worker and the webhooks worker.
- `discord` — the bot domain, laid out by concern: `api` (Discord REST client),
  `ai` (inference/config/spend), `commands` (specs + dispatch), `domain` (bans,
  limits, mention, outbox, responder policy, consumer, dlq, …), `ingress`,
  `contracts`. Shared by gateway/workflows/responder/spend.
- `outbound` — in-process outbound HTTP: the boundary client (host allowlist,
  credential injection, caps) + profiles. `createEgressClient(env, profile,
  caller)` returns a boundary `fetch`; the credential is resolved from the calling
  worker's env. No worker, no hop.
- `contracts-core` — the capnp `EventEnvelope` kernel: schemas, framing,
  encode/decode. Queue payloads are plain capnp envelopes.
- `rpc` — the uniform `RpcResult` shape for trusted service-binding calls.
- `queue-kit` — `createQueueWorker(service, handlers)` (no signing).
- `secrets` — pluggable secret backends; `logger`; `service-kit` — the residual
  identity **types** only (`MachinePrincipal`, `Subject`, `RequestContext`); its
  signing/Cedar/registry implementation has been removed.

**Dependency rules** — enforced by `scripts/check-dep-direction.ts`: packages
never import apps; an app never imports another app; the graph stays acyclic.

## Trust model (do not regress)

- **Worker-to-worker calls are plain Cloudflare service-binding RPC.** No signed
  envelopes, no identity tokens, no Cedar. Trust is structural: only a worker
  whose wrangler declares a binding (or is a queue producer/consumer) can make
  the call, so the binding graph authenticates the caller. Callers that need a
  principal pass it as a plain argument.
- **The auth worker is the single API Gateway for public ingress.** Every public
  app's middleware calls `AUTH.authenticateClient → verify → authorize` before a
  handler runs; backends trust the verdict and never re-check it (API-Gateway
  trust centralization — colocated service-binding hops are sub-1ms). The three
  public client kinds: `web` (Access + Better Auth session), `native` (operator
  bearer token or CF Access machine grant), `webhook` (signature verified at the
  edge with the app's own verifier).
- **Authorization is a data-driven policy table** (`apps/auth/src/policy.ts`):
  `(app, action) → rule` keyed on client kind / role / subject-allowlist / admin.
  Deny by default. It replaces the former Cedar engine. Domain rules that don't
  cross the edge (Discord command admin/ban gating, broker per-connector
  capabilities) are plain data checks next to the domain.
- **External edges always verify** (this is the real authentication and must
  never be dropped): Discord Ed25519 (`apps/webhooks`), provider HMAC
  and provider webhook HMAC (auth worker, secret never leaves it), CF Access + Better Auth
  (`apps/auth`).
- **Outbound HTTP is in-process.** The RPC method that needs it builds a boundary
  client (`createEgressClient` from `@rag/outbound`; profiles in
  `packages/outbound/profiles.ts`) and fetches directly — host allowlist +
  credential injection are enforced by the boundary client, and the credential is
  the calling worker's own secret. Webhook signing secrets live only on the auth
  worker (verifyWebhook resolves them per provider).
- **Fail closed, disclose nothing**: denials return a bare status; the reason is
  logged, never echoed. Never log request bodies, headers, tokens, or secrets.
- **Wire hygiene**: queue sends use `contentType: "bytes"` (JSON mangles
  Uint8Array); messages are capped below 128 KiB; validators run on encode and
  re-run on decode.
- Decided and settled: the `DiscordGateway` DO stays in the gateway worker and
  `InteractionSession` stays in the workflows worker (moving a DO class between
  scripts needs a risky transfer migration — keep worker names stable).

## How to add things

**A new application:** `pnpm scaffold <name>` generates a complete, compiling,
test-green `apps/<name>`: a `wrangler.jsonc` (with the `AUTH` binding),
`package.json`, an `src/index.ts` on `createAppWorker` with a sample
authenticated route + RPC handler, `src/openapi.ts`, a registration in
`scripts/deploy.ts` `DEPLOY_ORDER`, and a seeded auth policy entry. Then
`pnpm install && pnpm run check && pnpm test`. Give it a subdomain by adding a
`routes` entry to its wrangler; implement your route handler (it receives the
authenticated `principal`) and use `@rag/outbound` for any outbound HTTP.

**A new webhook provider:** add its HMAC scheme to `packages/auth-kit/webhook.ts`
(+ the `WebhookEventProvider` union in `packages/discord/contracts`) and its
secret env var to the auth worker's `WEBHOOK_SECRET_ENV` map. The webhooks worker
calls `AUTH.verifyWebhook` (never sees the secret), dedupes, and enqueues a
`webhook.event` to workflows.

**A new internal service worker (no route):** scaffold or hand-write a worker
whose `src/index.ts` exports a `WorkerEntrypoint` (RPC) and/or a
`createQueueWorker(service, handlers)` default. Callers bind it and call its
methods directly.

## Key flows (mental model)

```
Public request → app worker (createAppWorker) → AUTH.authenticateClient/verify/
        authorize → route handler → RPC to a backend → in-process outbound fetch
Discord interaction → webhooks (verify Ed25519, type-5 ack, kick InteractionSession)
        → processor DO (pre-flight + handler) → edit reply → outbound
Discord mention (gateway ws) → InteractionSession.runMention → AI + D1 → responder
ai/spend/webhook jobs → plain capnp envelopes over trusted queues → consumers
```

## Testing

`pnpm test` runs vitest inside workerd (`@cloudflare/vitest-pool-workers`; config
boots the gateway worker). Tests live in `test/packages/*` and `test/apps/*`;
`test/helpers.ts` has the env + Discord-signed-request builders. Worker HTTP
surfaces are tested through their fetch handlers / RPC entrypoints, not by
mocking internals. Auth-path tests drive `createAppWorker` against a stubbed
`AUTH` binding; RPC-path tests call `WorkerEntrypoint` methods directly.

## Gotchas

- Node 22+ for wrangler; `pnpm install` (never npm — `workspace:*` deps). The
  better-auth/zod peer warning on install is upstream noise.
- `pnpm run contracts:build` needs the native capnp compiler (`brew install
  capnp`); generated modules are committed.
- Generated files (`openapi.yaml`, `src/openapi.ts`, `packages/contracts-core/
  envelope.ts`) are committed — regenerate via scripts, never hand-edit.
- D1: change schema via `migrations/` only. Never point `preview_database_id` at
  prod. The AI usage guard fails open on D1 errors (deliberate); guild allowlist
  and every security boundary fails closed.
- Deploy order: `pnpm run deploy` follows `DEPLOY_ORDER` (auth first; workflows
  before gateway for the InteractionSession cross-script DO). `apps/webhooks`
  bootstraps separately via `--only webhooks`.
