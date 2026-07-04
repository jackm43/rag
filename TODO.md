# TODO

Running task list for the connectors + admin work and the surfaces around it.
Cross-references `CONNECTORS.md` (design) and `STATUS.md` (running state).

## Webhook ingress (own subdomain, validate, queue)

Centralised inbound webhooks on their own worker + subdomain, kept off the
Discord-interaction gateway (different threat model; providers can't pass CF
Access).

- [x] New edge worker `ragbot-webhooks-worker` at **`webhooks.jsmunro.me`**,
      routes **`/{provider}/{id}`** — `{provider}` selects the signature scheme
      (e.g. `/github/{id}`, `/stripe/{id}`), `{id}` is the connector slug. NOT
      behind CF Access (third parties POST to it).
- [x] Signature verification stays in the **broker**, not the edge receiver:
      the `webhook_verify` op — the receiver reads the RAW body and hands the
      broker `{provider, signatureHeaders, bodyBase64}`; the broker resolves the
      per-connector webhook secret via the secrets-provider, computes the
      provider's HMAC (github + stripe schemes, constant-time), and returns
      `{valid, eventId?}`. The receiver never sees the secret.
- [x] New Cedar action `connector.webhook.verify` + `webhooks -> connectors`
      (and `webhooks -> workflows`) service hops (services.cedar) + `webhooks`
      machine principal, mirroring how `dev-proxy -> connectors` was added.
- [x] Validate → **enqueue-only** → return 2xx fast: a `webhook.event` capnp
      envelope in a `ServiceMessage` (on-behalf-of token, subject
      `webhook:{connectorId}`, edge→application) onto `webhook-jobs` → workflows
      consumer (verified receive, logs the event, processing left as a seam).
- [x] Idempotency + replay: `WebhookDedupe` DO keyed on the broker-returned
      event id (24 h TTL); stripe additionally timestamp-bounded broker-side
      (github signs no timestamp — dedupe is its replay control).
- [x] Per-connector webhook config in the registry (`ConnectorConfig.webhook`:
      provider scheme, secret ref, enabled flag).
- [x] Update `CONNECTORS.md` webhook section + `openapi`/docs once wired.

## Connectors admin surface — remaining

The `/api/connectors/*` admin surface is live; these are the reserved/next bits.

- [x] Implement the reserved 501 endpoints: `POST /api/connectors/{id}/grant`
      (= 3LO consent begin — the dev-proxy still holds no grant/fetch/token
      permit), `GET /api/connectors/{id}/installations` (`admin_installations`),
      `GET|POST /api/connectors/{id}/callback` (callback at
      `ragbot-dev.jsmunro.me/api/connectors/{id}/callback`).
- [x] 3LO provider wiring (Discord) — `discord-user` registry entry; begin
      persists a single-use, subject-bound OAuth state; complete consumes it and
      stores tokens in the encrypted 3LO store.
- [x] Bind `CONNECTORS` on the **workflows** (the first credential caller); the
      `workflowsToConnectors` client + `workflows -> connectors` Cedar permits already
      exist.

## Separate tracked tasks (flagged, not part of the admin-surface work)

- [x] **Rename the brain worker** — now the **workflows** worker
      (`ragbot-workflows-worker`, principal `workflows`, `WORKFLOWS_SIGNING_KEY`,
      `workers/services/workflows`). Same keypair, re-keyed in the committed
      keyring; never deployed under the old name, so no live cutover. Done
      together with extracting AI Gateway / Workers AI access (credential, URL
      construction, binding-vs-HTTP routing) into `packages/inference` — the
      single seam the workflows implement their model calls through.
- [ ] **Task 12 remainder** — per-operation Cedar enforcement across all hops
      (manifests already carry `operations`; the dev-proxy + connectors hops gate
      on their operation end to end).
- [ ] Dev-proxy hardening — a real interaction bridge so async AI-command results
      are observable in-browser; broaden the admin surface as it grows.
- [ ] Revisit the deferred "generated app-client servers" idea.

## Egress + attest work (done)

- [x] **Egress migration completed** — all outbound HTTP for discord-rest,
      discord-webhook, cloudflare-api, media-download, and ai-gateway now flows
      through the `egress` service worker as signed `egress.request` hops with
      bundled default profiles (`packages/egress/profiles.ts`); `DISCORD_BOT_TOKEN`,
      `CF_AIG_TOKEN`, and `CLOUDFLARE_API_TOKEN` moved off the application workers
      onto the egress worker.
- [x] **Attest pattern refactor** — `workers/applications/attest` now follows the
      thin-middleware → signed `attest.invoke` → `ATTEST_SERVICE` self-binding
      pattern, with business logic in `service_server/src/{operations,webhook}.ts`.
- [x] **Placement fail-closed** — the `ServiceRegistry` placement control plane
      denies a hop when an env has no working `SERVICE_REGISTRY` binding, instead
      of silently letting it through.
- [x] **JWKS + honest discovery** — the gateway serves a real
      `/.well-known/jwks.json` from the committed keyring; discovery docs no
      longer advertise unimplemented `/oauth/*` endpoints.
- [x] **Shared Better Auth module + deploy order** — session module moved to
      `packages/boundaries/inbound/better-auth.ts` (dev-proxy + registry both use
      it); `npm run deploy` order is egress → connectors → responder → registry →
      attest → metadata → gateway → workflows → spend.

## Known deliberate exceptions

Not every outbound call goes through the egress sidecar or a signed service
hop, on purpose:

- The connectors broker's per-connector **provider HTTP** stays on the direct
  `packages/boundaries/outbound` client — provider hosts are dynamic,
  per-registration, and already credentialed, so a wildcard egress profile
  would be a security regression.
- The **Vault secrets backend** likewise stays on the direct boundary client
  for the same dynamic-host reason.
- The **1Password SDK** does its own HTTP entirely outside any boundary
  client (it is not a `fetch` call this codebase controls).
