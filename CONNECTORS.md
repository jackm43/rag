# Connectors — the credential broker

The **connectors** service (`workers/services/connectors`, worker
`ragbot-connectors-worker`) is the single home for third-party provider
credentials — GitHub App keys, static API keys, OAuth client secrets, per-user
OAuth grants. It is reachable **only** over a service binding (no route, no
queue), and it is the one place a real provider secret lives at runtime.

Its hard invariant: **every operation, for every connector, is BOTH
authenticated (an identity-context token verified through the same
`createServiceServer` pipeline every service hop uses — Ed25519 signature,
`aud`/`iss`/`exp`, envelope-hash binding) AND authorized (Cedar) before any
credential is touched.** The provider secret never leaves the broker by default.
Everything fails closed.

---

## The phantom-token model (the core pattern)

A caller **never receives a real provider credential**. Every connector kind
works identically through two steps — even a static API key is treated as
"3-legged" (app identity → token exchange → opaque handle):

```
  ┌────────┐   1. grant(connectorId, subject?, scopes?, params?)   ┌──────────┐
  │ caller │ ─────────────────────────────────────────────────────▶│  broker  │
  │ (app)  │                                                        │          │  resolves/prepares the
  │        │◀───────────────  opaque handle (phantom token)  ───────│          │  real credential internally,
  └────────┘                                                        │          │  stores a GRANT ENTRY (actor
      │                                                             │          │  context + credential reference),
      │  2. authorizedFetch(handle, request)  /  getAccessToken(handle)         │  returns ONLY the handle.
      └────────────────────────────────────────────────────────────▶│          │
                                                                     │          │  re-verifies identity token,
                       response  /  short-lived token                │          │  re-checks the handle is bound
      ◀──────────────────────────────────────────────────────────── │          │  to THIS caller, re-runs Cedar,
                                                                     └──────────┘  resolves the credential, injects
                                                                                    it, fetches through the boundary
                                                                                    client, writes an AUDIT entry.
```

1. **GRANT (the uniform token exchange).** The caller — authenticated by its
   identity-context token over the binding and Cedar-authorized — calls
   `grant`. The broker resolves/prepares the underlying credential internally
   (api_key = the static key; client_credentials = a minted grant token;
   github_app = an installation token; auth_code = the stored user tokens for
   that subject) but does **not** return it. It creates a **grant entry**
   capturing the full actor context — `{grantId, connectorId, callerPrincipal
   (the app machine id), subject, scopes, params, createdAt, expiresAt}` — and
   returns **only** the opaque handle. The handle is a high-entropy `cg_…`
   reference (256 bits); it holds no structure to forge.

2. **USE.** The caller calls `authorizedFetch(handle, request)` (preferred),
   `getAccessToken(handle)` (the escape hatch), or `introspect(handle)`. The
   broker looks up the grant, **re-verifies** the caller's identity token, checks
   the handle was **issued to this exact caller principal** (a leaked handle is
   useless to any other service), re-runs Cedar against the stored actor
   context, resolves the real credential, injects it, and — for a fetch —
   performs the outbound call through the connector's host-allowlisted boundary
   client. The real credential never leaves the broker on the fetch/introspect
   paths. Every use writes an audit log entry with the complete actor chain.

**Why phantom (opaque-reference) tokens.** A leaked bearer credential is usable
by anyone; a leaked handle is inert (bound to caller + subject, short-lived,
revocable, and it dereferences to nothing without passing the broker's gates).
The real secret stays server-side, and because every *use* re-enters the broker,
every use is a natural audit point capturing all the actors.

> **Split-token variant (Curity).** An optimization where the handle is
> `<random>.<reference>`: the caller holds the random half, the broker stores
> `SHA-256(random)` next to the reference, and lookup is a hash compare. It
> saves a store round-trip on introspection. We implement the plain
> opaque-reference form (a store lookup) for clarity; the split-token layout can
> be added behind the same handle string without changing the API.

---

## The four connector kinds

A connector is a declarative config entry keyed by `kind` (see
`packages/connectors/registry.ts` and `ConnectorConfig` in
`packages/connectors/types.ts`). Each kind is one **strategy**
(`packages/connectors/strategies/*`) that resolves the real credential:

| kind | secret held | grant prepares | fetch injects | getAccessToken |
|---|---|---|---|---|
| `api_key` | a static API key | validates the key exists | the configured header (`headerTemplate`) | **unsupported** (an API key is not a mintable short-lived token — use fetch) |
| `oauth2_client_credentials` (2LO) | OAuth client secret | performs the `client_credentials` grant, caches the token to ~expiry | `Authorization: <type> <token>` | the cached grant token |
| `oauth2_authorization_code` (3LO) | OAuth client secret | reads (and refreshes) the subject's stored tokens | `Authorization: Bearer <token>` | the user access token |
| `github_app` | the App RSA private key | mints an App JWT (RS256), exchanges it for an **installation** token, caches to ~expiry | `Authorization: Bearer <installation-token>`, `Accept: application/vnd.github+json` | the installation token |

3LO additionally exposes `beginAuthorization` / `completeAuthorization`. The
strategy + storage seam for 3LO is fully defined, but no 3LO provider is wired
in this task (Discord is a follow-up); the abstraction supports it cleanly.

---

## The grant / use API

The broker exposes ONE service-binding method, `Connectors.invoke(message)`,
where `message` is a capnp `ServiceMessage` (the identity token beside a
`connector.invoke` `EventEnvelope`). The envelope's `operation` field selects
the operation. Callers use the `connectorsClient` helper
(`packages/connectors/client.ts`) rather than framing this by hand:

```ts
const client = connectorsClient(env, serviceClients(env).brainToConnectors, { sub: userId });

// 1. GRANT — exchange identity for a handle (never a credential)
const { grant } = await client.grant("github-app", { params: { installationId: "12345678" } });
//    grant = { handle: "cg_…", connectorId: "github-app", expiresAt }

// 2a. USE — the preferred path; the credential stays broker-side
const { fetch } = await client.authorizedFetch(grant.handle, {
  method: "GET",
  path: "/repos/canva/ragbot/issues",
});
//    fetch = { status, headers (filtered), body }

// 2b. USE — the escape hatch; returns a real short-lived token for direct calls
const { token } = await client.getAccessToken(grant.handle);
//    token = { value, tokenType, expiresAt }

// 2c. introspect — the handle's actor context (never a secret)
const { introspection } = await client.introspect(grant.handle);
```

Every result is fail-closed: a coarse HTTP-shaped `status` (200 ok, 401
unauthenticated, 403 forbidden, 404 unknown handle/connector, 502 upstream, 500
internal) and, on success, exactly the one body field for the operation. A
denial carries no detail — the broker logs the reason internally and never
discloses which gate refused.

### How authn + authz apply to EVERY operation

`handleConnectorInvoke` (`packages/connectors/handler.ts`) runs the same
fail-closed order for every op:

1. **`createServiceServer` verification** — the identity-context token is
   verified (Ed25519 signature, `aud == connectors`, `iss` in the caller
   allowlist, `exp`/`iat` window, envelope-hash binding); the operation is
   checked against the broker's one registered service operation
   (`connector.invoke`); and Cedar `service.invoke` authorizes the hop. This
   authenticates the **calling service**.
2. **Cedar `connector.*`** — the per-connector capability gate against
   `Connector::<id>` with the verified caller as principal
   (`packages/authz/policies/connectors.cedar`). Actions: `connector.grant`,
   `connector.fetch` (also gates `introspect`), `connector.token`,
   `connector.authorize` (3LO begin/complete). A caller may only touch a
   connector it is **explicitly** permitted.
3. **Handle binding** (use ops) — the grant is looked up and must have been
   issued to *this* verified caller; re-checked on every use.
4. **Only then** is the credential resolved server-side, injected, and sent
   through the connector's boundary client.

Cedar `connector.*` grants are deliberately **explicit permits**, not derived
from the registry: a manifest change can never silently widen who can reach a
credential. The service-hop layer (`services.cedar`) is registry-driven with
static bootstrap permits, exactly like the other services.

### Audit entry shape

Every use emits `connector_use` at info level with the complete actor chain:

```json
{
  "level": "info",
  "message": "connector_use",
  "operation": "fetch",
  "connectorId": "github-app",
  "grantId": "cg_…",
  "callerPrincipal": "brain",
  "delegates": ["gateway", "brain"],
  "subject": "1069…",
  "host": "api.github.com",
  "path": "/repos/canva/ragbot/issues",
  "method": "GET",
  "status": 200,
  "outcome": "ok"
}
```

`grant` emits `connector_grant`; denials emit `connector_denied` (with a coarse
`reason`); 3LO steps emit `connector_authorize_begin` / `_complete`.

---

## How to add a new connector

Adding a provider that fits an existing kind is a **config entry** in
`packages/connectors/registry.ts` plus a **Cedar permit** in
`packages/authz/policies/connectors.cedar`. Only a genuinely new authentication
shape needs a new strategy.

### Example: an API-key connector

1. **Registry entry** (`CONNECTOR_REGISTRY`):

   ```ts
   {
     id: "example-api",
     kind: "api_key",
     host: "api.example.com",            // the ONLY host this connector may reach
     cedarResource: "example-api",
     secretBinding: "EXAMPLE_API_KEY",   // env/secret holding the key
     headerTemplate: { header: "authorization", scheme: "Bearer" },
   }
   ```

2. **Cedar permit** — grant a caller the operations it needs:

   ```cedar
   @id("brain-example-api-grant")
   permit (principal == Machine::"brain", action == Action::"connector.grant",
           resource == Connector::"example-api");
   @id("brain-example-api-fetch")
   permit (principal == Machine::"brain", action == Action::"connector.fetch",
           resource == Connector::"example-api");
   ```

3. **Secret** — `wrangler secret put EXAMPLE_API_KEY -c workers/services/connectors/wrangler.jsonc`.

That's it. `client.grant("example-api")` then `client.authorizedFetch(handle, …)`
works; the key is injected as `Authorization: Bearer <key>` and never leaves the
broker.

### Example: an OAuth2 client-credentials (2LO) connector

1. **Registry entry**:

   ```ts
   {
     id: "example-2lo",
     kind: "oauth2_client_credentials",
     host: "api.example.com",
     cedarResource: "example-2lo",
     tokenUrl: "https://auth.example.com/oauth/token",
     clientId: "example-client-id",
     secretBinding: "EXAMPLE_CLIENT_SECRET",
     defaultScopes: ["read"],
   }
   ```

2. **Cedar permits** — as above, for the connector id `example-2lo`. Add
   `connector.token` too if a caller must extract the raw access token.

3. **Secret** — `wrangler secret put EXAMPLE_CLIENT_SECRET -c workers/services/connectors/wrangler.jsonc`.

The broker performs the `client_credentials` grant against `tokenUrl` (HTTP
Basic client auth), caches the access token until ~expiry, and injects
`Authorization: Bearer <token>` on fetch.

### Adding a caller (a new service that uses the broker)

1. Add the service to `CONNECTOR_CALLERS` in `handler.ts` (the crypto-layer
   issuer allowlist).
2. Add its `Connector::<id>` permits in `connectors.cedar`, and the
   `service.invoke` / `service.exchange` bootstrap permits + manifest target for
   the `<caller> → connectors` hop (mirror `brain` in `services.cedar` and
   `workers/services/brain/src/manifest.ts`).
3. Bind `CONNECTORS` on the caller's worker (`services` binding to
   `ragbot-connectors-worker`, entrypoint `Connectors`) and hold a
   `<caller>ToConnectors` client (`packages/auth/client.ts`).

---

## Operator: provisioning the GitHub App connector (the reference impl)

The `github-app` connector is wired and tested. To make it live:

1. **Create the GitHub App.** GitHub → *Settings → Developer settings → GitHub
   Apps → New GitHub App*. Give it the repository permissions the bot needs
   (e.g. Contents: read, Issues: read/write). It needs no callback URL (this is
   App/installation auth, not user OAuth). Note the **App ID** (a number).

2. **Generate a private key.** On the App's page, *Private keys → Generate a
   private key*. GitHub downloads a `.pem` (PKCS#1, `BEGIN RSA PRIVATE KEY`). The
   broker accepts PKCS#1 or PKCS#8 verbatim — no conversion needed.

3. **Install the App.** *Install App* → choose the org/account and the
   repositories. The URL after install contains the **installation id** (a
   number); it is also discoverable via the API. Callers pass it as the grant
   param `installationId`.

4. **Set the secrets** on the connectors worker:

   ```sh
   wrangler secret put GITHUB_APP_ID          -c workers/services/connectors/wrangler.jsonc
   wrangler secret put GITHUB_APP_PRIVATE_KEY  -c workers/services/connectors/wrangler.jsonc
   #   (paste the numeric App id, then the full PEM including BEGIN/END lines)
   wrangler secret put SERVICE_PUBLIC_KEYS     -c workers/services/connectors/wrangler.jsonc
   #   (the production verifying keyring JSON — public keys, kept out of config)
   ```

5. **Which worker binds the broker.** No worker binds `CONNECTORS` yet. The
   intended first caller is the **brain**: add a `services` binding
   (`ragbot-connectors-worker`, entrypoint `Connectors`) to
   `workers/services/brain/wrangler.jsonc`, then call via
   `connectorsClient(env, serviceClients(env).brainToConnectors, subject)`. The
   `brainToConnectors` client and the `brain → connectors` Cedar permits already
   exist.

6. **Use it:**

   ```ts
   const { grant } = await client.grant("github-app", { params: { installationId: "12345678" } });
   const { fetch } = await client.authorizedFetch(grant.handle, {
     method: "GET",
     path: "/repos/OWNER/REPO",
   });
   ```

### Secrets storage — upgrade path

Secrets are worker secrets today (`wrangler secret put`). They can later be
sourced from **Cloudflare Secrets Store** (a `secrets_store_secrets` binding),
which centralizes rotation and access control. The strategies read secrets by
binding *name* (`secretBinding` / `appIdBinding`), so moving to Secrets Store is
a binding change, not a code change. The 3LO OAuth token store additionally
supports application-level AES-GCM at rest via `CONNECTORS_TOKEN_ENC_KEY` (on top
of the Durable Object's platform at-rest encryption).
