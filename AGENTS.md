# Working in this repo

Read the [README](README.md) first for what the system is and how to run it.
This file is the developer/agent guide: the architecture, the invariants you
must not regress, and the checklists for adding things.

Run `pnpm run check` (tsc + dependency-direction check) and `pnpm test` before
calling anything done. Wrangler needs Node 22+. Commands that touch secrets go
through `op run --env-file=.env --`.

## Architecture

pnpm workspace, three product apps + shared packages, all named `@rag/*`:

- `apps/bot` — the Discord bot: `workers/gateway` (Discord ingress + the
  `DiscordGateway` Durable Object), `workers/workflows` (AI job consumer — the
  only worker that runs AI), `workers/responder` (Discord write policy),
  `workers/spend` (AI Gateway cost reconciliation). App code in `lib/`
  (domain commands, discord helpers, ai/inference), messages in `contracts/`.
- `apps/connectors` — the credential broker (`workers/broker`), webhook
  ingress (`workers/webhooks`), dev-proxy admin app (`workers/dev-proxy` +
  React web UI). Broker internals in `lib/`, generated API types in
  `devproxy-client/`, messages in `contracts/`.
- `apps/platform` — registry (control-plane DOs: `ServiceRegistry`,
  `ApplicationRegistry`), attest, metadata, and the egress sidecar worker.
  Scaffold generator in `lib/registry-kit`, messages in `contracts/`.
- `packages/` — only genuinely shared code:
  - `contracts-core` — the envelope kernel: capnp `EventEnvelope` /
    `ServiceMessage` schemas + generated modules, framing guards, transport
    encode/decode, validation primitives. App message types do NOT live here.
  - `service-kit` — the service-boundary library: signed hops
    (`createClient` / `createServiceServer`), manifests + registry client,
    the fail-closed placement control plane, Ed25519 identity tokens
    (`service-kit/identity`, committed public keyring), and the edge harness
    (`service-kit/edge`).
  - `authz` — Cedar engine + `policies/*.cedar`; `ingress` — inbound guards
    (CF Access, Better Auth session, operator token); `egress` — the egress
    sidecar client/server + `egress.request`/`application.request` contracts
    (+ `egress/outbound`, the legacy direct client); `secrets` — pluggable
    secret backends (wrangler-env, cloudflare-secret-store, vault,
    1password); `logger`.

**Layer split inside every application** (one deployed worker per app):
`api/middleware_client` is the public edge — ingress guards, request shaping,
generated OpenAPI, and a signed hop into the app's own `service_server` via a
loopback service binding (`*_SERVICE` bound to the same worker's
`WorkerEntrypoint`). Business logic lives only in `service_server`. Edge
workers are built on `createEdgeWorker` (`packages/service-kit/edge.ts`),
which owns manifest registration, the optional perimeter guard, `/health`,
`/openapi.json`, 405-with-Allow, and the 404 fallback.

**Dependency rules** — enforced by `scripts/check-dep-direction.ts` (part of
`pnpm run check`): packages never import apps; apps import other apps only
through `lib/`, `contracts/`, or `devproxy-client/` (never another app's
`workers/`); the workspace graph stays acyclic.

**Env slices** — there is no global `Env`. Each shared package declares the
slice it reads (`ServiceKitEnv`, `IngressEnv`, `EgressEnv`, `SecretsEnv`);
each app's `contracts/` composes the slices plus its own bindings into that
app's `Env`. New bindings go in the owning slice, not a grab-bag.

**Trust zones** (`packages/service-kit/principal.ts`): `platform` (public
ingress/egress workers), `application` (internal domain workers),
`management` (admin surfaces), `control-plane` (registry / trust machinery).

## Security invariants (do not regress these)

- **Every worker-to-worker hop is a signed `ServiceMessage`**: capnp envelope
  bytes + an Ed25519 JWS binding `{sub, act, iss, aud, exp 60s, jti,
  envelopeSha256}` (RFC 8693-style on-behalf-of; each hop re-mints with
  itself as issuer and extends the delegation chain). Receivers verify
  signature/issuer/audience/expiry/payload-hash **before** Cedar, which runs
  **before** any handler.
- **Operation registration gate**: a `(service, operation)` pair must be in
  the sender's and receiver's manifests or the envelope is refused at the
  contract layer.
- **Cedar is the only authorization engine** (`packages/authz`).
  `service.exchange` at client build, `service.invoke` at receive, plus
  domain actions (`command.*`, `gateway.*`, `connector.*`, `egress.use`).
  Deny by default; use `authorizeAndForward` so there is no ignorable
  boolean. Admins are data: `RAG_ADMIN_USER_IDS` in
  `packages/authz/entities.ts`.
- **Placement control plane fails closed**: no working `SERVICE_REGISTRY`
  binding ⇒ the hop is denied, never silently allowed.
- **Credentials live at the edge of the system only.** Outbound HTTP goes
  through the egress sidecar (signed `egress.request`; profiles in
  `packages/egress/profiles.ts`); provider secrets live only in the
  connectors broker (phantom-token model — callers get opaque handles,
  `authorizedFetch` runs broker-side). Deliberate exceptions: the broker's
  dynamic provider hosts and the Vault backend stay on
  `packages/egress/outbound`; the 1Password SDK does its own HTTP; the
  `DiscordGateway` DO keeps the bot token for websocket IDENTIFY.
- **Fail closed, disclose nothing**: denials return a bare status; the reason
  is logged (shared `service_denied` shape), never echoed. Never log request
  bodies, headers, tokens, or secret material — ids and envelope kinds only.
- **Wire hygiene**: queue sends use `contentType: "bytes"` (JSON silently
  mangles Uint8Array); messages are capped at 128 KiB (validators enforce
  body caps below that); producers validate on encode AND consumers
  re-validate on decode (zero trust between hops).
- Decided and settled: signing stays **per-worker** (no central STS); the
  `DiscordGateway` DO stays in the gateway worker (moving a DO class between
  scripts needs a risky transfer migration).

## How to add things

Start with the scaffolder — it generates compiling code, registers the worker
in `DEPLOY_ORDER`, and prints the remaining manual steps:

```sh
pnpm run scaffold app <id> [--display "Name"] [--route "GET /api/x opId svc.op"]...
pnpm run scaffold worker <id> --app <bot|connectors|platform> [--queue <name>]
pnpm run scaffold connector <id> --kind api_key --host <host> --secret-ref <ENV>
```

`scaffold app` reuses the registry's `buildApplicationScaffold`
(`apps/platform/lib/registry-kit/scaffold.ts` — the same generator behind the
registry app's PR flow), so the local and hosted paths cannot drift.
The checklists below are what the scaffolder automates.

### A new application (public API or web app)

1. **Home**: a new product gets `apps/<app>/` with a `package.json` (name
   `@rag/<app>`, `exports: {"./*": "./*.ts"}`, deps on the `@rag/*` packages
   it uses — pnpm-workspace.yaml already globs `apps/*`). A worker inside an
   existing product goes under that app's `workers/`.
2. **Worker skeleton**: `workers/<id>/api/middleware_client/{src,wrangler.jsonc}`
   and `workers/<id>/service_server/src`. One wrangler config per deployed
   worker; the service server is reached via a loopback `services` binding
   (`"service": "<own worker name>", "entrypoint": "<Entrypoint class>"`),
   plus the external `SERVICE_REGISTRY` DO binding
   (`script_name: "ragbot-registry-worker"`). Web UI (if any) in
   `workers/<id>/web` with a self-anchored vite config.
3. **Contracts**: add the payload struct + union arm in
   `packages/contracts-core/envelope.capnp`, run `pnpm run contracts:build`,
   then put the TS job type, validator, and encode/decode in **your app's**
   `contracts/` module (build them from `@rag/contracts-core` kernel helpers:
   `initEnvelope`, `readEnvelope`, `compact`, the `is*` validators). Add your
   bindings to your app's `Env` there too.
4. **Identity**: add the `MachinePrincipal` + zone in
   `packages/service-kit/principal.ts`; write the manifest (`service`, `zone`,
   `targets`, `operations`); add Cedar permits in
   `packages/authz/policies/services.cedar` (bootstrap `service.invoke` /
   `service.exchange`) and any domain actions in their policy file. If the
   worker initiates hops: `tsx scripts/generate-keys.ts <id>`, public JWK
   into `service-kit/identity/keyring.ts`, private JWK as a
   `<ID>_SIGNING_KEY` secret.
5. **Edge worker**: `export default createEdgeWorker({...})` with routes;
   define `application-bindings.ts` (`X_APPLICATION`, `X_ROUTE_BINDINGS`,
   optional `X_SECURITY_SCHEMES`/`X_SCHEMAS`) — `pnpm run routes:build`
   discovers it and generates `openapi.yaml` + `src/openapi.ts`
   automatically. Hop into the service server with `prepareApplicationHop`.
6. **Deploy**: add the worker name to `DEPLOY_ORDER` in `scripts/deploy.ts`
   (deploy fails loudly until you do — place it before anything that binds
   it). Create any queues/KV first.
7. **Tests** in `test/apps/<app>/`; run `pnpm run check` — the
   dependency-direction check will catch layering mistakes.

### A new webhook ingress

Usually you don't need a new worker: the central receiver
(`apps/connectors/workers/webhooks`) handles
`POST webhooks.jsmunro.me/{provider}/{connectorId}` generically. To accept a
new provider: add its HMAC scheme to `apps/connectors/lib/webhooks.ts`, the
provider to the `WebhookEventProvider` union + `SIGNATURE_HEADERS` map, a
webhook config on the connector's registry entry (secret ref + enabled), and
a `connector.webhook.verify` Cedar permit. The receiver verifies via the
broker (never sees the secret), dedupes on the broker-returned event id, and
enqueues a signed `webhook.event` to the workflows worker — consumers go
there.

### A new internal service worker (no public route)

Steps 1, 3, 4, 6, 7 above, minus the edge: a single worker dir with
`wrangler.jsonc` + `src/`, reached only by service binding or queue. Queue
consumers use `createQueueWorker(manifest, handlers)`
(`packages/service-kit/queue-worker.ts`) so manifest registration and
unknown-queue handling are inherited; receive with
`createServiceServer(...).receive(message, decode, transport)`.

### A new connector (third-party credential)

Config, not code, if the auth shape exists (`api_key`,
`oauth2_client_credentials`, `github_app`, 3LO): add a registry entry in
`apps/connectors/lib/registry.ts` (id, kind, single `host`, `cedarResource`,
`{provider, ref}` secret reference), Cedar permits per operation in
`packages/authz/policies/connectors.cedar`, and the secret on the broker.
A genuinely new auth shape adds a `lib/providers/<name>.ts` strategy. A new
**caller** of the broker: add it to `CONNECTOR_CALLERS` in `lib/handler.ts`,
give it connector + service-hop permits and a manifest target, and bind
`CONNECTORS` on its worker.

## Key flows (mental model)

```
Discord → gateway (verify sig, Cedar, mint origin token, enqueue)
        → workflows (verify, Cedar, AI + D1; re-mint per hop)
        → responder (output policy: sanitize, cap, allowed_mentions)
        → egress (host/profile policy, inject credential, fetch)
webhooks edge → broker webhook_verify → dedupe DO → workflows queue
dev-proxy (CF Access → Better Auth session → allowlisted subject)
        → gateway DevProxy binding → the ordinary command pre-flight
```

The dev-proxy is the admin app that runs in production: Access is the
perimeter, Better Auth (Discord OAuth, standalone `ragbot-auth` D1) supplies
the acting Discord subject, sessions are bound to the Access identity, and
the gateway independently enforces `DEV_PROXY_ALLOWED_SUBJECTS`.

## Testing

`pnpm test` runs vitest inside workerd (`@cloudflare/vitest-pool-workers`;
config in `vitest.config.ts` boots the gateway worker plus a stub registry
worker). Tests live in `test/packages/*` (shared packages) and `test/apps/*`
(app + worker behaviour); `test/helpers.ts` has the signed-message and env
builders. Worker HTTP surfaces are tested through their routers/fetch
handlers, not by mocking internals.

## Gotchas

- Node 22+ for wrangler; `pnpm install` (never npm — `workspace:*` deps).
  The better-auth/zod peer warning on install is upstream noise.
- `pnpm run contracts:build` needs the native capnp compiler
  (`brew install capnp`); generated modules are committed.
- Generated files (`openapi.yaml`, `src/openapi.ts`, `src/routes.ts`,
  `devproxy-client/api-types.ts`, `packages/contracts-core/envelope.ts`) are
  committed — regenerate via scripts, never hand-edit.
- D1: change schema via `migrations/` only. `rag_ai_interactions` keeps a
  dual-INSERT fallback (prod may lack the token-usage columns; SQLite has no
  `ADD COLUMN IF NOT EXISTS`). Never point `preview_database_id` at prod.
- AI config is memoized per isolate — `config:push` affects new isolates
  only; a redeploy refreshes everything.
- The AI usage guard fails open on D1 errors (deliberate); the guild
  allowlist and everything security-boundary fails closed.
- Open threads: per-operation Cedar enforcement across all hops (manifests
  already carry `operations`); a real dev-proxy interaction bridge for async
  AI results; the deferred "generated app-client servers" idea.
