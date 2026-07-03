# TODO

Running task list for the connectors + admin work and the surfaces around it.
Cross-references `CONNECTORS.md` (design) and `STATUS.md` (running state).

## Webhook ingress (own subdomain, validate, queue)

Centralised inbound webhooks on their own worker + subdomain, kept off the
Discord-interaction gateway (different threat model; providers can't pass CF
Access).

- [ ] New edge worker `ragbot-webhooks-worker` at **`webhooks.jsmunro.me`**,
      routes **`/{provider}/{id}`** — `{provider}` selects the signature scheme
      (e.g. `/github/{id}`, `/stripe/{id}`), `{id}` is the connector slug. NOT
      behind CF Access (third parties POST to it).
- [ ] Signature verification stays in the **broker**, not the edge receiver: add
      a `connector.webhook.verify` op — the receiver reads the RAW body and hands
      the broker `{connectorId, provider, signatureHeader, rawBody}`; the broker
      resolves the per-connector webhook secret via the secrets-provider, computes
      the provider's HMAC, and returns a bool. The receiver never sees the secret
      (same phantom-token philosophy as `authorizedFetch`, applied inbound).
- [ ] New Cedar action `connector.webhook.verify` + `webhooks -> connectors`
      service hop (services.cedar) + `webhooks` machine principal, mirroring how
      `dev-proxy -> connectors` was added.
- [ ] Validate → **enqueue-only** → return 2xx fast: frame a capnp
      `ServiceMessage` (mint an on-behalf-of token, edge→application, Cedar-gated
      like gateway→brain) onto a webhook queue → brain. No slow work inline
      (providers retry on non-2xx/timeout).
- [ ] Idempotency + replay: dedupe on the provider's event id; enforce a
      timestamp tolerance (as the Discord interaction path already does).
- [ ] Per-connector webhook config in the registry / config store (which
      provider scheme, which secret ref, enabled flag).
- [ ] Update `CONNECTORS.md` webhook section + `openapi`/docs once wired.

## Connectors admin surface — remaining

The `/api/connectors/*` admin surface is live; these are the reserved/next bits.

- [ ] Implement the reserved 501 endpoints: `POST /api/connectors/{id}/grant`,
      `GET /api/connectors/{id}/installations`,
      `GET|POST /api/connectors/{id}/callback` (callback at
      `ragbot-dev.jsmunro.me/api/connectors/{id}/callback`).
- [ ] 3LO provider wiring (Discord) — the `oauth2_authorization_code`
      begin/complete + callback flow; the strategy/storage seam already exists.
- [ ] Bind `CONNECTORS` on the **brain** (the first credential caller); the
      `brainToConnectors` client + `brain -> connectors` Cedar permits already
      exist.

## Separate tracked tasks (flagged, not part of the admin-surface work)

- [ ] **Rename the brain worker** (separate task).
- [ ] **Task 12 remainder** — per-operation Cedar enforcement across all hops
      (manifests already carry `operations`; the dev-proxy + connectors hops gate
      on their operation end to end).
- [ ] Dev-proxy hardening — a real interaction bridge so async AI-command results
      are observable in-browser; broaden the admin surface as it grows.
- [ ] Revisit the deferred "generated app-client servers" idea.
