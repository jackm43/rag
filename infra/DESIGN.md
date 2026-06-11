# Trust Zone Platform - Engineering Design

This document describes the design of the trust zone platform: a personal
zero-trust infrastructure in which every request, human or machine, carries a
short-lived, cryptographically verifiable identity, and in which no component
trusts another by virtue of network position, deployment location, or shared
long-lived secrets.

The document is organized as modules. Each module opens with a short narrative
aimed at a high-level reader (the problem, the outcome, the security and
usability story) and then moves into design detail: responsibilities,
interfaces, interactions, security requirements, and user experience.
Interfaces are given as pseudo-code; flows are given as high-level pseudo-code
or numbered steps. The intent is that an engineer could implement any module
from this document without being over-constrained by it.

Vocabulary used throughout:

- "trust zone": the logical security boundary formed by the gateway, its
  registered applications, and the identities it issues. Membership in the
  zone is proven per-request with tokens, never assumed.
- "edge auth gateway" (or "gateway"): the central security token service,
  registry, and discovery endpoint, deployed on an edge runtime.
- "identity-aware proxy": the upstream SSO layer that fronts human
  authentication and hosts the OIDC federation app.
- "edge runtime": the serverless platform on which gateway and applications
  run, with managed key-value and SQL storage and durable single-writer
  objects available as primitives.
- "secret manager": the external vault used for confidential material, always
  accessed by reference, never by copied value.
- "operator CLI": the single command-line tool used for login, discovery,
  invocation, bootstrap, registration, and deployment.

---

## Module 1: Platform Overview and Zero-Trust Principles

### Narrative

Small platforms fail at security in a predictable way: a handful of long-lived
API keys accumulate in dotfiles, CI variables, and deployment configs; every
service implicitly trusts every other service; and when something leaks there
is no inventory of what it could do or any record of what it did. The trust
zone platform exists to make the secure path the only path, at a scale where
one person operates everything. The outcome is a system where credentials are
short-lived by default, every privileged action is attributable to a person or
a workload, secrets exist in exactly one place, and adding a new application
is a declarative, repeatable act rather than a pile of console clicks.

The security story is defense in depth around a single chokepoint: the edge
auth gateway mints all intra-zone credentials, so policy, lifetime, and audit
are enforced in one component. The usability story is that the operator never
notices any of it: one browser login per device per year, transparent token
refresh, and a CLI that can call any registered method without per-service
configuration.

### Principles

These principles are normative. Every module below must satisfy them, and any
future module must be evaluated against them.

1. No ambient trust. A request is authorized by what it carries (token,
   proof, certificate), never by where it comes from. The edge runtime
   network, deployment co-location, and "internal" hostnames confer nothing.
2. Short-lived credentials everywhere. Access tokens live minutes, not days.
   Anything that must live longer (refresh tokens, service credentials,
   certificates) is either sender-constrained, stored hashed, rotated on a
   schedule, or all three.
3. Single issuer, single policy point. Only the gateway mints trust zone
   tokens. Applications verify; they never issue. Authorization grants
   (scopes, delegation policies) are registered at the gateway and enforced
   there at issuance time, then re-checked at the application per method.
4. Proof of possession over bearer where the client can manage a key. Public
   clients (CLI, browser) bind sessions to device keys with DPoP. Bearer
   tokens are tolerated only at 5-minute lifetimes with strict audience
   scoping.
5. Identity is layered, not flattened. When service B calls service C on
   behalf of user U, the resulting token says so explicitly (actor chain).
   Impersonation - B pretending to be U - is structurally impossible.
6. Everything is discoverable. Clients learn issuer endpoints, application
   endpoints, methods, and scopes from discovery documents. Nothing is
   hardcoded, so the platform can move, rename, and rotate without breaking
   clients.
7. Secrets are references. Configuration carries vault references (`op://`
   in the current 1Password implementation), never copied values. Resolution
   happens at the last possible moment (deploy time or runtime), by an
   identity authorized to resolve.
8. Auditability is a feature, not a log file. Every issuance, exchange,
   refresh, revocation, registration, and privileged RPC is recorded with the
   full resolved identity (including actor chains) in a queryable store.
9. Declarative over imperative. The desired state of the zone - applications,
   delegations, webhooks, worker configuration - lives in version-controlled
   manifests. The CLI reconciles reality toward the manifest.
10. Fail closed, degrade loudly. Unknown audience, unknown scope, stale key,
    unverifiable proof: all are hard denials with audited reasons, never
    fallbacks.

### System shape

```
                          +---------------------------+
  browser login           | identity-aware proxy      |
  (OIDC code + PKCE) ---> |  - OIDC federation app    |
                          |  - email allowlist policy |
                          +-------------+-------------+
                                        | upstream access token
                                        v
 +-----------+  DPoP session  +---------------------+   JWKS, discovery
 | operator  | <------------> |  edge auth gateway  | <------------------+
 | CLI /     |  STS exchange  |  - STS (RFC 8693)   |                    |
 | web app   | -------------> |  - sessions (DPoP)  |                    |
 +-----------+                |  - registry         |                    |
       |                      |  - discovery        |                    |
       | short-lived          |  - audit log        |                    |
       | audience-scoped      +----------+----------+                    |
       | tokens                          | issues tokens                 |
       v                                 v                               |
 +-------------+   chained exchange  +-------------+   verify via JWKS   |
 | application | ------------------> | application | --------------------+
 |     A       |  (subject + actor)  |     B       |
 +-------------+                     +-------------+
```

All applications and the gateway run on the edge runtime. State lives in
managed SQL storage (registry, audit, sessions) and durable objects (signing
keys, long-lived connections). The secret manager and the identity-aware
proxy are the only external trust dependencies.

### Threat model summary

In scope:

- Theft of any single credential at rest (laptop dotfiles, browser storage,
  CI logs, worker config). Mitigated by sender constraints, short lifetimes,
  hashing, and references.
- Replay of captured tokens. Mitigated by DPoP proofs (per-request, nonce and
  method/URI bound), 5-minute lifetimes, and audience scoping.
- A compromised application attempting lateral movement. Mitigated by
  delegation policy: an application can only chain to audiences and scopes it
  has registered grants for.
- Refresh token theft. Mitigated by key binding (useless without the device
  key) plus rotation with reuse detection (a replayed refresh token revokes
  the whole session).
- Operator account compromise at the upstream identity provider. Partially
  mitigated: allowlist plus the proxy's own MFA; residual risk acknowledged
  in Module 15.

Out of scope (accepted risks for a personal platform):

- Compromise of the edge runtime provider itself.
- Compromise of the secret manager provider itself.
- Malicious code in the operator's own toolchain at build time (addressed
  partially by future supply-chain work, Module 15).

---

## Module 2: User Authentication and the Public Client (CLI)

### Narrative

The operator CLI is a public client: it ships no secret, runs on a laptop,
and yet must hold credentials capable of administering the entire zone. The
classic failure mode is a long-lived bearer token in a config file - one
`grep` away from total compromise. This module eliminates that: the CLI
authenticates the human once via the browser, then converts that into a
device-bound session in which every token is useless off the device. The
outcome for the operator is one browser interaction per device per year and
zero credential management; the outcome for security is that stolen state
files are inert.

### Responsibilities

- Run the OIDC authorization code + PKCE flow against the OIDC federation
  app, via the system browser, with a localhost loopback redirect.
- Generate and persist a per-device asymmetric key pair (the DPoP key).
- Establish a gateway session: exchange the upstream access token plus a
  DPoP proof for a sender-constrained gateway access token and a rotating
  refresh token.
- Transparently keep the session fresh: any CLI command that needs a token
  acquires one without user interaction unless the session is dead.
- Exchange session tokens for application-audience STS tokens on demand
  (see Module 4), caching per audience until near expiry.
- Store all local state through the secret service file provider with owner-
  only permissions (see Module 9).

### Login flow

```
flow cli_login():
    config    = fetch(gateway_discovery_url)        # Module 4 discovery
    verifier  = random(64); challenge = S256(verifier)
    state     = random(32); port = listen_loopback()
    open_browser(config.oidc.authorization_endpoint
                 + client_id, redirect=http://127.0.0.1:{port}/cb
                 + code_challenge=challenge, state, scope="openid email")
    # identity-aware proxy enforces SSO + email allowlist here
    code      = await_loopback_callback(verify state)
    upstream  = post(config.oidc.token_endpoint,
                     grant=authorization_code, code, verifier)   # PKCE
    dpop_key  = load_or_generate_device_key()       # ES256, local store
    proof     = dpop_proof(dpop_key, htm=POST, htu=config.session_endpoint)
    session   = post(config.session_endpoint,
                     subject_token=upstream.access_token,
                     dpop=proof)
    store(session.access_token,    ttl=5m,  bound: cnf.jkt=thumb(dpop_key))
    store(session.refresh_token,   ttl=rotating, bound to thumb(dpop_key))
```

Notes:

- The upstream access token is used exactly once, to bootstrap the session,
  and is not persisted beyond the upstream provider's own refresh handling.
- The device key is generated locally, never leaves the machine, and is
  stored via the secret service file provider (0600, owner-only directory).
- The loopback listener accepts exactly one request, validates `state`, and
  responds with a static "return to your terminal" page.

### Session refresh and rotation

```
flow get_session_token():
    if cached_access_token fresh (>30s remaining): return it
    proof = dpop_proof(dpop_key, htm=POST, htu=refresh_endpoint,
                       nonce=last_server_nonce)
    resp  = post(refresh_endpoint, refresh_token=current_rt, dpop=proof)
    if resp.error == invalid_grant:        # rotation reuse or revoked
        delete local session; raise NeedsBrowserLogin
    rotate: current_rt = resp.refresh_token   # old RT now dead server-side
    cache resp.access_token (5m)
    return resp.access_token
```

Properties the gateway enforces (client must tolerate all of them):

- Access tokens: 5 minutes, ES256, `cnf.jkt` set to the device key
  thumbprint. Resource servers must check the proof against `cnf.jkt`.
- Refresh tokens: opaque, single-use, rotated on every refresh, bound to the
  same key thumbprint, sliding window up to 12 months from session creation.
- Reuse detection: presenting an already-rotated refresh token revokes the
  entire session family. The legitimate client experiences this as
  `invalid_grant` and falls back to browser login. This is intentional: it
  converts a theft into a forced re-auth rather than a silent compromise.
- DPoP nonce: the gateway may respond with `use_dpop_nonce`; the client
  retries once with the supplied nonce. Proofs carry `iat` (skew window of
  about 60 seconds), `jti` (replay-checked server-side), `htm`, `htu`.

### Why this protects a public client

- A copied state file contains: a 5-minute access token (likely already
  expired), a refresh token that cannot be used without the device private
  key, and the device private key file itself. The last is the real target,
  which is why it lives owner-only in the secret service file store and is a
  candidate for OS keychain or hardware-backed storage later (Module 12,
  Module 15).
- A captured access token in transit cannot be replayed against any resource
  server that checks DPoP, and expires within minutes regardless.
- A captured refresh token used by an attacker triggers reuse detection on
  the next legitimate refresh (or immediately, if the attacker lacks the key
  - the gateway rejects before rotation, and logs the attempt).

### User experience requirements

- `cli login` is the only command that may open a browser. Every other
  command transparently performs session refresh and STS exchange.
- If the session is expired, revoked, or the device key is missing, any
  command fails with a single actionable line: "session expired, run: cli
  login" - never a stack trace, never a partial operation.
- `cli whoami` prints the resolved identity, session expiry, key thumbprint,
  and the audiences with currently cached STS tokens.
- `cli logout` revokes the session at the gateway (best effort), then
  deletes local tokens and optionally the device key (`--purge-key`).

---

## Module 3: Web Application Clients

### Narrative

Some trust zone applications will grow browser frontends, and the browser is
the most hostile place a credential can live: XSS can read anything readable.
This module brings the CLI's device-bound session design to the web using
platform cryptography, so that even a script-injection attacker who can read
all of storage cannot exfiltrate a usable session. This is design-ahead work:
no web client exists yet, and the module is written so a frontend SDK can be
implemented directly from it. The outcome is parity: web sessions get the
same DPoP binding, rotation, and reuse detection as CLI sessions, with login
UX no worse than any SSO-protected web app.

### Key design decision: non-extractable keys

The browser equivalent of "the private key never leaves the device" is a
`CryptoKey` generated with `extractable: false` and persisted in IndexedDB.
The key material is held by the browser's crypto implementation; script can
sign with it but can never read it. An XSS attacker can therefore mint DPoP
proofs only while their code is running in the victim's live page - a real
but bounded capability - and cannot steal the session for offline or
remote use. This is the strongest binding available without WebAuthn, and
WebAuthn-based session binding is the planned upgrade (Module 15).

### Architecture

- The web application's static assets and its backend-for-frontend (if any)
  are themselves registered trust zone applications, deployed on the edge
  runtime behind the identity-aware proxy. The proxy provides the first
  authentication gate (SSO, allowlist) before any application code runs.
- After the proxy admits the user, the frontend SDK runs the same OIDC code
  + PKCE flow as the CLI (the federation app supports both redirect URIs),
  then establishes a gateway session with a browser-resident DPoP key.
- The frontend calls trust zone applications directly with STS tokens plus
  per-request DPoP proofs; there is no cookie-based ambient session to CSRF.

### Frontend auth SDK interface

```
interface TrustZoneWebAuth {
    // One-time setup; reads discovery, opens or resumes a session.
    init(opts: { discoveryUrl: string }): Promise<SessionState>

    // Redirect-based login. Returns only via handleRedirect().
    login(): void
    handleRedirect(): Promise<SessionState>   // call on the callback route

    // Core acquisition: audience-scoped STS token + matching DPoP proof.
    // Internally: silent session refresh, per-audience token cache.
    tokenFor(audience: string, scopes?: string[]): Promise<{
        accessToken: string,            # send as Authorization: DPoP <token>
        proofFor(method, url): string   # fresh proof per request
    }>

    // fetch wrapper that injects token + proof and retries once on
    // use_dpop_nonce challenges.
    fetch(audience: string, input: Request): Promise<Response>

    onSessionChange(cb: (s: SessionState) => void): void
    logout(opts?: { everywhere?: boolean }): Promise<void>
}

type SessionState =
    | { status: "none" }
    | { status: "active", subject: string, expiresAt: Date,
        keyThumbprint: string }
    | { status: "needs_login", reason: "expired"|"revoked"|"key_lost" }
```

### Key and token storage

```
flow ensure_device_key():
    db = indexeddb.open("trustzone-auth")
    key = db.get("dpop-key")
    if key missing:
        key = crypto.subtle.generateKey(ES256,
                                        extractable=false,
                                        usages=[sign])
        db.put("dpop-key", key)        # structured clone of CryptoKey
    return key
```

- DPoP key: non-extractable `CryptoKey` pair in IndexedDB. Clearing site
  data destroys it; the design treats that as device-key loss (forced
  re-login), identical to the CLI deleting its key file.
- Refresh token: stored in IndexedDB alongside the key. This is acceptable
  precisely because it is inert without the non-extractable key; an
  exfiltrated refresh token cannot be refreshed elsewhere.
- Access tokens and per-audience STS tokens: memory only, never persisted.
  A page reload performs one silent refresh to rebuild the cache.

### Per-request proof generation

```
flow signed_request(audience, request):
    tok   = tokenCache.get(audience) or sts_exchange(audience)
    proof = jws(ES256, key=device_key, header={typ:"dpop+jwt", jwk:pub},
                payload={ htm: request.method, htu: request.url,
                          iat: now, jti: random(),
                          ath: sha256(tok.accessToken),
                          nonce: nonceCache.get(origin) })
    request.headers["Authorization"] = "DPoP " + tok.accessToken
    request.headers["DPoP"]          = proof
    resp = fetch(request)
    if resp is 401 with DPoP-Nonce header:
        nonceCache.set(origin, header); retry once
    return resp
```

Including `ath` (hash of the access token) in web proofs binds proof to token
and prevents an attacker who obtains only proofs from pairing them with a
different token.

### Silent refresh and lifecycle

- The SDK refreshes the gateway session in the background when the access
  token has less than 60 seconds remaining and a request is pending, or
  proactively on a timer while the tab is visible. Refresh uses the same
  rotation and reuse-detection semantics as Module 2.
- Multiple tabs coordinate through a `BroadcastChannel` plus a Web Locks
  mutex around refresh, so rotation is never raced (a raced rotation would
  trip reuse detection and kill the session).
- `logout()` revokes server-side, clears IndexedDB token state, and emits
  `onSessionChange`. With `everywhere: true` it revokes the whole session
  family for that user across devices via a gateway endpoint.

### Security requirements

- Strict Content-Security-Policy on all web frontends (no inline script,
  pinned script origins): XSS is the principal threat to this design and the
  proxy + CSP are the primary mitigations.
- The SDK must refuse to run on non-HTTPS origins (localhost excepted for
  development).
- No tokens in URLs, localStorage, or cookies. The OIDC callback uses the
  code (not implicit) flow; the code is single-use and PKCE-bound.
- The gateway applies the same per-key session limits and reuse detection to
  web sessions; web and CLI sessions for the same user are independent
  session families.

---

## Module 4: The Edge Auth Gateway

### Narrative

The gateway is the heart of the trust zone: the only component that mints
credentials, the registry of everything that exists, and the place where
every security-relevant event is recorded. Concentrating these duties in one
small, well-audited service is what makes the rest of the platform simple -
applications only ever verify, clients only ever discover and exchange. The
outcome is that policy changes (lifetimes, scopes, delegations, revocations)
happen in exactly one deployment, and the blast radius of any application
compromise is bounded by what the gateway agreed to issue it.

### Responsibilities

- Security token service: RFC 8693 token exchange issuing short-lived ES256
  JWTs for registered audiences.
- Session service: issuing and refreshing DPoP-bound user sessions
  (Modules 2 and 3).
- Signing key lifecycle: generation, weekly rotation, JWKS publication.
- Registry: applications, resources, methods, scopes, service clients,
  delegation policies (Modules 5, 6, 7).
- Discovery: machine-readable metadata for the issuer and every registered
  application.
- Audit: append-only log of all issuance, refresh, revocation, registration,
  and administrative activity.

### Token exchange (STS)

Endpoint: `POST /<idp-service>/ExchangeToken` (also reachable through the
generated RPC surface; the gateway's own API is itself a registered
application).

```
request ExchangeTokenRequest {
    grant_type           = "urn:ietf:params:oauth:grant-type:token-exchange"
    subject_token        : string      # who the token is FOR
    subject_token_type   : enum {
        gateway_session_token,         # Modules 2/3 (DPoP-bound)
        upstream_oidc_access_token,    # identity-aware proxy token
        gateway_sts_token,             # chaining input (Module 7)
        service_credential             # client_id + secret (Module 5)
    }
    actor_token          : optional string   # service credential, chaining
    actor_token_type     : optional
    audience             : string      # registered application audience
    scope                : optional string   # space-separated, narrowing only
}

response { access_token, issued_token_type, token_type="Bearer"|"DPoP",
           expires_in=300 }
```

Issuance rules:

1. Resolve and verify the subject token per its type (signature, expiry,
   upstream introspection or local JWKS, DPoP proof if session-bound).
2. Resolve the audience to a registered application; unknown audience is a
   hard denial.
3. Compute grantable scopes:
   - user subject: scopes the user is entitled to for that audience
     (today: all registered scopes, since the allowlist is the user policy;
     the model leaves room for per-user grants later, Module 13).
   - chained subject: the intersection defined by the caller application's
     delegation policy (Module 7), not the subject token's original scopes.
   - service subject: scopes registered to that service client.
   Requested `scope` may only narrow the computed set.
4. Mint ES256 JWT: `iss` (gateway issuer URL), `sub` (stable subject id),
   `aud` (application audience), `exp` = now + 300s, `iat`, `jti`,
   `scope`, `act` (full actor chain when chaining), `cnf.jkt` (when the
   subject session is DPoP-bound and the audience opts into proof-bound
   tokens).
5. Write an audit record before returning (Module 4, audit section). If the
   audit write fails, the exchange fails: no unaudited issuance.

### Session issuance and refresh

```
POST /session            # subject: upstream OIDC token + DPoP proof
POST /session/refresh    # refresh_token + DPoP proof (same key)
POST /session/revoke     # session token or refresh token; family revocation
```

Server-side session state (managed SQL storage):

```
table sessions(
    id, subject, key_thumbprint, created_at, expires_at,   # <= 12 months
    family_id, revoked_at, revoked_reason)
table refresh_tokens(
    hash,                 # only a hash is stored
    session_id, generation, used_at, replaced_by_hash)
```

Rotation: each refresh marks the presented token `used_at` and issues
generation N+1. Presenting a token whose `used_at` is already set revokes
the family (`revoked_reason = "refresh_reuse"`), audits the event with both
the presenting IP/user-agent and the original issuance metadata, and returns
`invalid_grant`.

DPoP verification on session endpoints: validate proof signature against the
JWK in the proof header, check `htm`/`htu`/`iat`/`jti` (jti replay cache,
short TTL), require the key thumbprint to match the session's stored
`key_thumbprint`, and enforce the server nonce when one has been issued.

### Signing key lifecycle

Keys live in a durable single-writer object so rotation is race-free.

```
state SigningKeys {
    current:  { kid, private_jwk, created_at }
    previous: [{ kid, public_jwk, retired_at }]   # kept for verification
}

flow weekly_rotation():            # scheduled alarm
    new = generate ES256 keypair, kid = random id
    previous.push(public part of current); current = new
    prune previous entries older than max_token_lifetime + clock_skew
    publish updated JWKS
```

- Private keys never leave the durable object; signing is an RPC into it.
- JWKS at `GET /.well-known/jwks.json` includes current plus retained
  previous public keys, cache headers tuned so a rotation propagates within
  minutes (short max-age, must-revalidate).
- Verifiers (server SDK) cache JWKS by `kid` and refetch on unknown `kid`,
  so rotation requires no coordination.
- Emergency rotation: an authenticated admin RPC forces immediate rotation
  and optionally drops `previous` (invalidating all outstanding tokens -
  acceptable because they live 5 minutes).

### Discovery

`GET /api/discovery` returns everything a client needs; clients hardcode
only this one URL (and even that is overridable by environment variable).

```
{
  "issuer": "https://gateway.example",
  "jwks_uri": ".../.well-known/jwks.json",
  "session_endpoint": ".../session",
  "token_exchange": { "endpoint": "...", "grant_types": [...] },
  "oidc": {            # how to log in upstream
     "authorization_endpoint", "token_endpoint", "client_id",
     "redirect_uris", "scopes_supported"
  },
  "applications": [{
     "name", "audience", "endpoint", "description",
     "resources": [{ "service", "methods": [{ "name", "scope" }] }]
  }]
}
```

The applications section is what powers `cli discover`, `cli metadata`, and
generic `cli fetch <app>.<Service>.<Method>` invocation, and what the local
discovery documents (Module 5) are refreshed from.

### Audit logging

Every security-relevant event writes one structured row:

```
table audit(
    id, at, event,            # token.issue, token.exchange.chain,
                              # session.create/refresh/revoke/reuse_detected,
                              # registry.app.register/rotate/delete,
                              # admin.rpc, auth.denied
    subject,                  # resolved principal
    actor_chain,              # JSON, full act chain if any
    audience, scopes,
    decision, reason,         # allow / deny + machine-readable reason
    client_meta)              # ip, user agent, key thumbprint
```

Requirements: append-only (no update/delete RPC exists), written
synchronously for issuance decisions, queryable by the operator through a
registered admin service, and exportable as a stream for the future anomaly
detection module (Module 15). Denials are logged as richly as approvals.

### Security requirements

- The gateway exposes only: discovery, JWKS, session endpoints, token
  exchange, and its own registered RPC services (which require its own STS
  tokens - the gateway eats its own dog food, with bootstrap handled by the
  upstream OIDC subject type).
- All registry mutations require an admin-scoped user token; service
  credentials cannot modify the registry.
- Constant-time comparison for credential hashes; service secrets stored
  with a memory-hard hash; refresh tokens stored only as hashes.
- Clock skew tolerance of at most 60 seconds anywhere a timestamp is checked.

---

## Module 5: Application Registry and Onboarding

### Narrative

Adding a service to most platforms means a scavenger hunt: create
credentials in one console, paste them into another, write a client by hand,
and document the endpoint in a wiki that drifts. In the trust zone, an
application is born from one manifest entry and one CLI command. The command
validates the API contract, registers identity and authorization metadata at
the gateway, issues and vaults a service credential without ever displaying
it, and generates type-safe client and server code. The outcome is that the
gap between "I defined an API" and "anything in the zone can securely call
it" is minutes, and the registry is always the truth.

### Declarative manifest

The desired state of all applications lives in a version-controlled
`applications.yaml`:

```
applications:
  ragbot:
    description: "Discord bot admin services"
    endpoint: https://ragbot-worker.example.workers.dev
    worker: ragbot-worker
    config: wrangler.jsonc
    language: typescript
    provider: cloudflare
    trust_zone: tier2
    access:
      allowed_groups: [admins]
      allowed_idps: [github]
    delegations:
      - audience: deploy
        scopes: ["deploy/DeployService.ListWorkers"]
    webhooks:
      - name: discord
        type: ed25519
    post_deploy:
      - gateway-start
```

`platy app sync` reconciles the registry against the manifest: registers new
applications, updates changed metadata and delegation policies, flags
manual drift, and never deletes without `--prune` plus confirmation.

### Registration flow

```
flow register(app):
    protos = validate(proto_dir(app))          # buf-style lint + breaking
    resources = derive services/methods/scopes from protos (Module 6)
    resp = gateway.RegistryService.RegisterApplication(
              name, description, endpoint, audience=app.name,
              resources, delegations, webhooks)
    # resp contains a one-time service credential
    secretref = secret_service.Application
                  .StoreServiceClientCredential(app.name, resp.secret)
    write local discovery document(app, resp.metadata,
                                   credential={client_id, secretref})
    generate code:
       client (Go, connect-style RPC over HTTP) -> applications/<app>/client
       server (TypeScript, protobuf-es)         -> applications/<app>/server
```

Key properties:

- The plaintext credential exists only in memory during registration. It is
  stored to the secret manager and referenced thereafter; the gateway keeps
  only a hash. It is never printed, logged, or written to disk.
- `platy app rotate-client <app>` mints a new secret at the gateway, updates
  the vault item and the local document atomically (old secret honored for
  a short overlap window, then invalidated).
- `platy app delete <app>` revokes the credential, removes registry entries,
  and deletes the local document; vault items are tombstoned, not erased,
  for audit.

### Local discovery documents

`~/.config/<platform>/applications/<app>.json` mirrors registry metadata
(audience, endpoint, resources, scopes) plus the local credential reference.
The CLI prefers local documents for endpoint and audience lookups, falling
back to gateway discovery; `cli discover` refreshes documents from the
gateway while preserving stored credentials. This keeps every CLI command
fast and offline-tolerant without ever caching secrets in plaintext.

### Generated code and metadata

- Contracts are protobuf-first in `infra/proto/<app>/v1/`. Regenerate with
  `infra/scripts/generate.sh [app...]` (buf + protoc-gen-go, connect-go,
  protobuf-es). Generated output lands in `infra/applications/<app>/client`
  (Go) and `infra/applications/<app>/server` (TypeScript); these directories
  are not committed.
- Generated servers plug into the server SDK (`createRpcHandler` +
  `protect`, Module 6) so auth enforcement is impossible to forget.
- Generated clients embed nothing environment-specific: endpoint and
  audience are resolved through discovery at runtime.
- Regeneration is idempotent and CI-checkable: a dirty diff after
  `generate.sh` fails the build.

### Security requirements

- Registration and mutation require admin user tokens (never service
  credentials), and every change is audited with a registry diff.
- Audience strings are unique, immutable after creation, and equal to the
  application name; renaming means re-registering.
- The manifest may contain only references, never secret values; the CLI
  rejects a manifest containing anything matching secret-value heuristics
  (high-entropy strings in known-sensitive keys).

---

## Module 5b: Identity Proxy Providers, Trust Zones, and Organization Policy

### Narrative

The upstream identity-aware proxy (today Cloudflare Zero Trust) is an
external dependency, but the platform must not be welded to any vendor API
shape. Applications need a stable vocabulary for "how sensitive is this
workload" and "what must be true about the caller's device," while the CLI
maps that vocabulary onto vendor objects (Access policies, Gateway settings,
device posture rules, WARP enrollment). The outcome is a provider abstraction
with a version-controlled organization manifest, four trust tiers that
express intent in Cloudflare-aligned terms, and bootstrap/sync commands that
reconcile the upstream account toward the manifest using the vendor Go SDK.

### Provider abstraction

```
interface IdentityProxy:
    resolveTrustBoundary(hints) -> TrustBoundary
    bootstrap(boundary, opts) -> BootstrapResult
    listIdentityProviders(boundary) -> [IdentityProvider]
    ensureGroups(boundary, group_specs) -> {name: AccessGroup}
    ensureEmailAllowlistPolicy(boundary, emails, groups) -> policy_id
    ensureDevicePosture(boundary, enabled, rule_name) -> PosturePolicy
    setPostureEnabled(boundary, enabled, rule_name) -> PosturePolicy
    createAccessApplication(boundary, spec) -> AccessApplication
    ensureWorkersDevBypassApps(boundary, subdomain)
    ensureOAuthClient(boundary, name, scopes) -> client_id, scopes
    ensureOrganization(boundary, input) -> OrganizationPolicy
```

Implementations keep vendor terminology in their own packages (Cloudflare:
account id, team id, team name, auth domain). The CLI selects a provider
with `--provider` at bootstrap and per application in `applications.yaml`.
Policy names, standard group names (`admins`, `users`, `enrolled`), and
posture check types (`warp`) live in a provider-neutral policy catalog; the
Cloudflare implementation maps those intents onto Zero Trust API calls through
`cloudflare-go/v6`.

### Organization manifest

Desired upstream policy lives in `infra/applications/organization.yaml`:

```
organization:
  name: jsmunro
  provider: cloudflare

zero_trust:                         # account-level Cloudflare settings
  gateway:
    tls_decrypt: true               # Gateway configuration: TLS inspection
    inspection_mode: dynamic        # Gateway configuration: inspection.mode
  devices:
    gateway_proxy_enabled: true       # Device settings: WARP Gateway proxy
    gateway_udp_proxy_enabled: true
  posture:
    checks:
      - type: warp
        name: Platform WARP connected   # Device posture rule (type warp)

trust_zones:
  tier0:                            # root / privileged (JIT)
    groups: [admins]
    access_policy:                  # reusable Access policy
      approval_required: true
      purpose_justification_required: true
      session_duration: 5m
      isolation_required: true      # Browser Isolation (RBI)
      require_posture: true         # require[] device_posture rule
      mfa_config:
        session_duration: 0m          # step-up MFA every access

  tier1:                            # critical data-plane
    groups: [enrolled, admins]
    access_policy:
      session_duration: 24h
      isolation_required: true
      require_posture: true

  tier2:                            # platform apps (default registration tier)
    groups: [admins, users, enrolled]
    access_policy:
      session_duration: 24h

  tier3:                            # public enrollment before gateway sessions
    enroll:
      staff:
        idp_types: [github]
        require_posture: true
      contractor:
        require_warp_or_rbi: true     # RBI policy + WARP posture policy
      on_success:
        grant_group: enrolled
        gateway_session: true
      on_revoke:
        require_reenroll: true
```

Each tier maps to a reusable Access policy name `{tier}-{role}` (for example
`tier0-root`, `tier2-internal`). Tier 3 additionally provisions a self-hosted
enroll Access application at `enroll.<subdomain>.workers.dev` with staff and
contractor policies linked by precedence.

### Cloudflare API mapping

The manifest fields above are not arbitrary labels; they correspond to
specific Zero Trust surfaces:

| Manifest section | Cloudflare API | Key fields |
|---|---|---|
| `zero_trust.gateway` | `PATCH /accounts/{id}/gateway/configuration` | `settings.tls_decrypt.enabled`, `settings.inspection.mode` |
| `zero_trust.devices` | `PATCH /accounts/{id}/devices/settings` | `device_settings.gateway_proxy_enabled`, `gateway_udp_proxy_enabled` |
| `zero_trust.posture.checks` | `POST /accounts/{id}/devices/posture` | `type: warp`, `name` |
| `trust_zones.*.access_policy` | `POST /accounts/{id}/access/policies` | `approval_required`, `purpose_justification_required`, `session_duration`, `isolation_required`, `mfa_config`, `require` (device posture) |
| `trust_zones.tier3.enroll` | Access application + linked policies | self-hosted app, `allowed_idps`, staff/contractor policies |

Account-level settings (`gateway`, `devices`, `posture`) apply once per
bootstrap. Per-tier `access_policy` blocks become reusable policies attached
to applications at registration time according to each app's declared
`trust_zone`.

### Trust tiers vs trust boundaries

A **trust boundary** is the upstream Zero Trust organization resolved at
bootstrap (Cloudflare account + team name/domain). A **trust tier** is a
logical sensitivity class within that boundary:

| Tier | Role | Typical workloads |
|---|---|---|
| tier0 | root | break-glass, privileged operator actions (JIT approval) |
| tier1 | critical | databases, financial systems, high-sensitivity APIs |
| tier2 | internal | platform applications (gateway, ragbot, deploy) |
| tier3 | enroll | public enrollment and device trust establishment |

Applications declare `trust_zone: tier2` (default) in `applications.yaml`.
Registration resolves posture requirements from the tier's `access_policy`
unless `access.posture_required` overrides. Group membership (`admins`,
`users`, `enrolled`) is enforced through reusable Access groups created at
bootstrap.

### Bootstrap and reconciliation

```
flow platy_bootstrap():
    boundary = provider.resolveTrustBoundary(hints)
    organization = load(organization.yaml)
    result = provider.bootstrap(boundary, {
        email_allowlist, default_idp, access_app_name,
        posture_enabled: organization.needsPosture(),
        posture_check_name: organization.primaryPostureCheckName(),
    })
    # bootstrap creates: groups, admin allowlist policy, OIDC SaaS app,
    # device posture rule, workers.dev bypass apps, OAuth client
    groups = provider.ensureGroups(boundary, organization.groupSpecs())
    organization = provider.ensureOrganization(boundary, {
        organization, groups, identity_providers, posture_rule_id,
        workers_dev_subdomain,
    })
    write provider_config.json
    write client_metadata.json
    inject wrangler vars (ACCESS_TEAM_DOMAIN, ACCESS_OIDC_CLIENT_ID)
```

`platy manage organization sync` re-runs `ensureOrganization` against the
current manifest and updates `provider_config.json`, then syncs to the
gateway registry via `platy manage provider sync`. `platy manage posture
--enabled true|false` toggles the device posture rule without redefining
tiers.

Resolved boundary metadata (`provider_config.json`) and bootstrap outputs
(`client_metadata.json`, per-app `metadata.json`) are generated locally and
not committed; the manifest and protos are the source of truth.

### Principals, groups, and application access

Bootstrap creates reusable Access groups `admins`, `users`, and `enrolled`.
The admin group is seeded from `--email-allowlist`. Applications declare
which groups and identity providers may reach them:

```
applications:
  ragbot:
    provider: cloudflare
    trust_zone: tier2
    access:
      allowed_groups: [admins]
      allowed_idps: [github]
      posture_required: true    # optional override; else tier default
```

Allowed identity providers are resolved by name, type, or id during
registration. Group names map to provider group ids from the boundary
catalog synced into gateway discovery.

### Device posture

Posture is configured at two levels that must not be conflated:

1. **Account posture rules** (`zero_trust.posture.checks`): the WARP-connected
   device posture integration created at bootstrap.
2. **Access policy requirements** (`require_posture: true` on a tier or
   `access.posture_required` on an app): the Access policy `require[]` rule
   referencing that integration.

Gateway TLS inspection and WARP Gateway proxy are account settings under
`zero_trust.gateway` and `zero_trust.devices`, not Access policy fields.
Operators toggle posture enforcement with `platy manage posture --enabled
true|false`; disabling updates boundary metadata and syncs to the gateway.
Applications inherit the tier default unless `access.posture_required`
overrides it.

### Security account design (future)

A separate Zero Trust team for security-administration APIs (session revoke,
impersonation, audit search) remains a planned boundary split. Today all
platform applications share one Cloudflare team with tier-based separation
enforced through Access groups, tier policies, and per-application access
metadata. When a security team is added it would bootstrap independently,
register only minimum delegations, and require tier0/tier1 posture defaults.

The gateway remains the single STS issuer; upstream boundary separation is
enforced at the identity-aware proxy and in per-application access metadata,
not by issuing alternate token types.

---

## Module 6: Scopes, Services, and Methods Standards

### Narrative

Authorization systems rot when scope names are invented ad hoc: nobody knows
what a token can do, and reviews devolve into archaeology. The trust zone
fixes the namespace by construction: scopes are derived mechanically from the
API contract, so the set of scopes is exactly the set of callable methods,
and a token's `scope` claim reads as a literal list of permitted operations.
The outcome is authorization that is auditable by inspection and enforcement
that is generated, not hand-written.

### Naming convention

```
scope := <app> "/" <Service> "." <Method>        # canonical, per method
          e.g.  ledger/AccountService.GetBalance

wildcards (grant-side only, never minted into tokens):
    <app>/<Service>.*       all methods of a service
    <app>/*                 all methods of an application
```

Rules:

- `app` is the registered application name (and audience). `Service` and
  `Method` come verbatim from the proto definition.
- Tokens always carry fully expanded method scopes. Wildcards exist only in
  grants (delegation policies, service client registrations) and are
  expanded at issuance against the current registry. This keeps token
  inspection trivial and means a wildcard grant automatically covers new
  methods - a deliberate convenience that the audit log makes visible.
- Default scope: a method with no explicit override is protected by its
  canonical scope. Overrides in the proto (custom options) may mark a method
  `public` (no token required - e.g. health checks, webhook receivers which
  authenticate differently) or assign a shared scope for coarse grouping.
  Both overrides are surfaced in discovery metadata.

### Server SDK enforcement

Every generated server is wrapped by the SDK; there is no unauthenticated
code path unless explicitly declared.

```
interface AuthHandler {
    authenticate(req): Promise<Identity | Deny>
}

handlers provided by the SDK:
    stsAuthenticator(jwksUri, issuer, audience)   # gateway tokens
    oidcAuthenticator(upstreamConfig)             # raw upstream tokens
    verifySignedWebhook(algorithm, publicKeyRef)  # ed25519 platform hooks
    mtlsAuthenticator(...)                        # future, Module 11

flow protect(serviceImpl, opts):
    for each method m:
        wrap m with:
            identity = first successful handler in opts.handlers
                       else respond 401 (audited)
            required = opts.scopeOverrides[m] ?? canonical_scope(m)
            if required != "public"
               and required not in identity.scopes: respond 403 (audited)
            ctx.identity = identity        # sub, scopes, act chain, claims
            invoke m(ctx, request)
```

- Scope checks are exact string membership against the token's expanded
  scopes; the SDK never expands wildcards (tokens do not contain them).
- The SDK validates `iss`, `aud`, `exp`, `nbf`, signature via cached JWKS
  (refetch on unknown `kid`), and DPoP proof when the token carries
  `cnf.jkt`.
- The resolved identity, including any actor chain, is attached to the
  request context so application code can log and make finer-grained
  decisions (Module 13) without re-parsing tokens.

### Evolution rules

- Adding a method adds a scope; existing tokens (max 5 minutes old) simply
  lack it. No migration needed.
- Removing or renaming a method is a breaking change gated by proto breaking
  -change checks and requires `platy app sync` to update the registry; grants
  referencing the dead scope are flagged.
- Shared/coarse scopes are discouraged and require justification in the
  manifest; the default is always per-method.

---

## Module 7: Transitive Identity Chaining

### Narrative

The hardest identity problem in any service mesh is "service B calls service
C because user U asked it to." The lazy answers are impersonation (B
pretends to be U - C cannot tell, audit lies) or service identity (B calls as
itself - U's intent and entitlements vanish). The trust zone answer is
explicit delegation: B exchanges U's token, together with proof of B's own
identity, for a new token that names both U and B - and the gateway only
permits exchanges that B registered in advance. The outcome is that every
downstream hop is attributable to the full chain of who-asked-whom, and a
compromised service can only reach the audiences and scopes it was
explicitly granted.

### When to chain

Chain when a request handler needs to call another trust zone application
and the action is on behalf of the inbound caller. Do not chain for
background work the service does for itself (use its service credential as
subject instead) - the audit distinction matters.

### Exchange semantics

```
flow chained_call(inbound_token, target_audience, scopes):
    # inbound_token: the STS token this service received (subject)
    # service credential: this service's own identity (actor)
    new = gateway.ExchangeToken(
        subject_token       = inbound_token,
        subject_token_type  = gateway_sts_token,
        actor_token         = client_id + client_secret (resolved by ref),
        actor_token_type    = service_credential,
        audience            = target_audience,
        scope               = scopes)
    call target with new.access_token
```

Gateway validation order:

1. Verify subject token (own issuance, unexpired, any audience).
2. Authenticate actor credential; resolve to a registered application A.
3. Load A's delegation policy; require (target_audience, requested scopes)
   to be covered by A's registered grants. The subject token's original
   scopes are irrelevant here - delegation grants are the policy, which
   prevents a service from laundering a broad user token into audiences the
   operator never approved for that service.
4. Mint the token with an extended actor chain.

### The act claim

```
{ "sub": "user:jack",
  "aud": "notifier",
  "scope": "notifier/NotifyService.Send",
  "act": { "sub": "app:ledger",
           "act": { "sub": "app:reporting" } } }   # deepest = first hop
```

- The chain is append-only: each exchange nests the previous `act` value.
- Maximum chain depth is enforced (default 3); deeper chains indicate a
  design smell and are denied with an audited reason.
- Server SDK exposes the chain as `ctx.identity.actorChain`; applications
  may apply chain-aware rules (e.g. "only accept Send when the immediate
  actor is ledger").

### Delegation policy registration

Declared in the application manifest (Module 5) and stored in the registry:

```
table delegations(
    actor_app, target_audience, scope_pattern,   # wildcards allowed
    created_at, created_by)
```

Changes flow only through `platy app sync` with an admin user token, and every
grant addition or removal is audited. The discovery document for each
application lists its outbound delegations so the zone's call graph is
inspectable without reading code.

### What auditors see

Each chained issuance writes an audit row with the full resolved chain,
subject, target audience, granted scopes, and the matching delegation grant
id. A query like "everything service X did on behalf of users last week" is
a single filter on `actor_chain contains app:X`, and "who could ever reach
audience Y" is a registry query, not a code review.

---

## Module 8: Choosing an Auth Method

### Narrative

A platform with several credential types needs a bright-line rule for which
to use when, or developers will default to whatever worked last time -
usually the most powerful option. This module is that rule. The outcome is
that every integration in the zone uses the least powerful credential that
can do the job, and reviewers can verify the choice against one table.

### Decision table

| Situation | Use | Why |
|---|---|---|
| Human runs a CLI command or uses a web app | User session -> STS token for the target audience | Attributable to the person; DPoP-bound; 5 min |
| Service handles a user request and must call another zone service | Chained token (subject = inbound token, actor = service credential) | Preserves user identity; bounded by delegation policy |
| Service does background work for itself (cron, queue consumer) | STS token with service credential as subject | Attributable to the workload; no fabricated user |
| External platform pushes events (signed webhooks) | Signature verification (e.g. ed25519) via SDK webhook handler | The platform cannot hold zone tokens; verify provenance instead |
| Zone service must call the infrastructure provider's API | User-delegated provider OAuth token forwarded per request | No stored provider credentials; actions attributable to the operator |
| Zone service must call a third-party API for a user | Integration broker (Module 14) | Centralized grant storage, refresh, audit |
| CI / cloud dev environment needs zone access | Workload identity federation (Module 10) | No long-lived secrets in CI |
| Hardened service-to-service paths | mTLS + STS token (Module 11) | Defense in depth; transport identity plus request identity |

### Hard rules

- Never store an upstream OIDC token, provider OAuth token, or third-party
  token server-side beyond the request that carries it, except inside the
  integration broker (Module 14), which exists precisely to do that safely.
- Never use a service credential where a chained token is possible: if a
  user identity is present, it must survive to the audit log.
- Never accept a token minted for a different audience ("token passing");
  the SDK's audience check makes this structural, and chaining is the
  sanctioned alternative.
- Webhook-receiving endpoints are `public` scope but must verify signatures
  and must not perform privileged actions directly - they enqueue work that
  is then processed under a workload identity.

---

## Module 9: Secret Service Design

### Narrative

Secrets are most dangerous in transit between systems: pasted into configs,
echoed into terminals, committed by accident. The secret service makes the
secret manager the single place where secret values exist, and turns every
other occurrence into an opaque reference that is useless if leaked. The
outcome is that configuration, manifests, and even most of the CLI's own
state can be world-readable without compromise, and rotation is an update in
one place.

### Provider abstraction

```
interface SecretProvider {
    store(item: { title, fields: map<string,string> }): SecretRef
    resolve(ref: SecretRef): map<string,string>
    update(ref: SecretRef, fields): void
    delete(ref: SecretRef): void          # tombstone, not erase
}

providers:
    VaultProvider     # cloud secret vault; auth via service-account token
                      # when present, else interactive desktop integration
    FileProvider      # local encrypted/owner-only store under
                      # ~/.config/<platform>/secrets, 0600, for
                      # device-local material (DPoP keys, session tokens)
```

A `SecretRef` is a vault URI, e.g.
`op://<vault>/<item>/<field>` in the current 1Password provider, stable
across rotations. References appear in manifests, local discovery documents,
and worker configs; values appear nowhere persistent outside a provider.

### Namespace standards

```
services/<app>/client_secret        service client credentials (Module 5)
services/<app>/<purpose>            other app-owned secrets (api keys, etc.)
users/<subject>/<integration>/...   per-user third-party grants (Module 14)
device/<host>/dpop_key              local-only, FileProvider
device/<host>/session               local-only, FileProvider
```

- Application secrets vs user secrets are distinct namespaces with distinct
  access expectations: application secrets are resolved at deploy time by
  the operator or at runtime by the broker; user secrets are resolved only
  by the integration broker under an audited flow.
- The two-sided API mirrors this:
  `Service.Application.{Store,Resolve}ServiceClientCredential` and
  `Service.User.{Store,Resolve}Grant` - so call sites declare which class
  of secret they touch.

### Resolution points

- Deploy time: the CLI resolves `op://` references found in worker
  config templates and injects them as runtime secrets on the edge platform
  (write-only there), so nothing is copy-pasted (Module 5 deploy flow).
- Runtime (service): a service that must present its own credential (for
  chaining) resolves it via the platform's injected secret, not by calling
  the vault from the edge.
- Runtime (CLI): the CLI resolves credentials and device material through
  the provider chain transparently.

### Rotation

- Every secret class has an owner and a rotation verb: service credentials
  via `platy app rotate-client` (Module 5), webhook keys via manifest update +
  sync, user grants via broker re-consent or refresh (Module 14), device
  keys by deletion and re-login.
- Rotation always follows: create new -> propagate reference consumers ->
  verify -> invalidate old. References never change, so most rotations
  require no config edits at all.
- The vault's item history is retained; the platform never depends on it
  for correctness but uses it for incident forensics.

### Security requirements

- No provider may log values; the SDK redacts known-secret fields from any
  error path.
- FileProvider enforces directory and file modes on every access, refusing
  to read material with permissive modes.
- Vault access from automation uses a scoped service-account token that can
  touch only the platform's vault, itself provided to CI via workload
  identity (Module 10), not stored statically.

---

## Module 10: Workload Identity for Cloud Development Environments

### Narrative

The last long-lived secrets in most setups hide in CI variables and dev
container environments. This module removes them with the same trick large
clouds use: a workload proves who it is using an identity its platform
already attests (a signed runtime token, a metadata endpoint), and the
gateway exchanges that attestation for a normal short-lived trust zone
token. The outcome is that a fresh dev environment or CI job acquires zone
access with zero provisioned secrets, and revoking an environment is a
registry change, not a credential hunt.

### Ambient credential discovery chain

Client SDKs (Go and TypeScript) resolve credentials in a fixed order,
analogous to application-default credentials:

```
flow ambient_identity():
    1. if TRUSTZONE_TOKEN set:                 # explicit injection
           return static token (tests, escape hatch)
    2. if TRUSTZONE_CREDENTIALS_FILE set or default path exists:
           doc = parse file -> { type, ... }
           type "service_credential": resolve ref, exchange as subject
           type "federated":          go to step 3 with doc.attestation
    3. if running on an attesting platform (env heuristics):
           att = fetch platform identity token
                 (e.g. CI OIDC token endpoint, runtime metadata endpoint,
                  with audience = gateway issuer)
           return gateway.ExchangeToken(
               subject_token      = att,
               subject_token_type = federated_attestation,
               audience           = target)
    4. if interactive terminal: fall back to user session (Module 2)
    5. fail with explicit "no ambient credentials" error
```

### Federation registration

The gateway registry gains workload identity pools:

```
table federation_pools(
    name,                       # e.g. ci-main
    issuer,                     # attestation token issuer to trust
    jwks_uri,
    subject_pattern,            # e.g. repo:me/platform:ref:refs/heads/main
    claim_constraints,          # JSON: required claim values
    mapped_identity,            # workload:<name>
    allowed_audiences, allowed_scopes)
```

Exchange validation: verify the attestation against the pool's JWKS, match
`sub` and constrained claims against the pool, then issue a normal 5-minute
token with `sub = workload:<pool.mapped_identity>` limited to the pool's
audiences and scopes. Audit rows record the raw attestation subject and the
pool that matched.

### Use cases

- CI deploys: the pipeline's platform-issued OIDC token federates into a
  workload identity allowed `deploy/*` scopes; no deploy keys exist.
- Cloud dev environments: the environment's metadata identity federates into
  a low-privilege identity for `cli discover`/`cli fetch` against staging
  audiences.
- Vault access for automation (Module 9): the broker pattern - federate to
  the zone, then use a zone-audited endpoint that performs the vault call
  server-side - is preferred over giving CI a vault token at all.

### Security requirements

- Pools pin issuer and JWKS; constraints must include enough claims to
  prevent confused-deputy matches (e.g. branch and repository, not just
  repository).
- Attestation tokens must carry the gateway as audience; generic-audience
  platform tokens are rejected.
- Federated identities can never be subjects of further delegation grants
  by default; granting chaining to a workload is an explicit registry act.

---

## Module 11: Service-to-Service mTLS

### Narrative

Tokens authenticate requests; mTLS authenticates connections. For the
zone's most sensitive paths - registry mutation, secret-adjacent services -
requiring both means an attacker needs to steal a private key and mint a
valid token, and the edge can reject junk traffic before any application
code runs. This module designs the workload certificate layer as an additive
control: nothing about token verification changes, mTLS is a second
independent check. The outcome is defense in depth with no application code
beyond one extra SDK handler.

### Design

- Certificate issuance: the workload CA (Module 12) issues short-lived
  client certificates (24h-7d) to registered applications and to the
  operator CLI on request. Issuance is an authenticated gateway RPC: the
  requester presents its normal identity (service credential or user
  session), submits a CSR, and receives a certificate binding
  `SAN = spiffe-style URI: trustzone://app/<name>` (or `user/<sub>`).
- Edge verification: the edge runtime's TLS termination is configured (per
  hostname) to require client certificates from the zone's CA and to pass
  the verification result and certificate identity to the worker as request
  metadata.
- SDK handler:

```
mtlsAuthenticator(opts):
    cert = request.tls_client_auth        # edge-provided verification data
    if cert.verified != true: deny
    return Identity{ sub: parse_san(cert), method: "mtls" }

combined policy per method:
    require mtls identity AND sts token identity; require they agree
    (token sub/act chain consistent with certificate identity) when both
    name workloads.
```

- Rollout is per-application and per-route: `worker.mtls: required |
  optional | off` in the manifest. `optional` logs mismatches without
  denying, enabling a safe migration.

### Operational flow

```
flow renew_certificates():            # CLI cron or worker alarm
    for each app with mtls enabled:
        key = generate keypair (never leaves the workload / CLI)
        csr = sign CSR(key, san=trustzone://app/<name>)
        cert = gateway.CertificateService.Issue(csr)   # authn: app cred
        install cert+key via platform secret injection
    renew at 50% lifetime; alert past 80%
```

### Security requirements

- Certificates never substitute for tokens: a valid client cert with no
  (or mismatched) STS token is denied on protected methods.
- Private keys are generated where they are used and never transit the
  gateway; the CA sees only CSRs.
- Lifetimes are short enough (max 7 days) that revocation lists are a
  backstop, not the primary control; the edge config is also updated to
  distrust a compromised intermediate immediately (Module 12).

---

## Module 12: Certificate Authority Design

### Narrative

Once the platform issues certificates to workloads, and potentially to
devices and users, it needs a real CA story: a hierarchy that bounds blast
radius, issuance flows tied to existing identities, lifetimes that make
revocation rarely matter, and a clear answer to where software keys (DPoP)
end and certificates begin. The outcome is one coherent PKI in which every
certificate is traceable to a gateway-audited issuance event, and a
compromised intermediate can be cut off without re-keying the world.

### Hierarchy

```
trust zone root CA (offline; key held in secret manager, used rarely)
 |- workload intermediate CA   (online, gateway-held; issues Module 11)
 |- device intermediate CA     (online; issues device certs, future)
 |- user intermediate CA       (online; issues user certs, future)
```

- Root: 10-year self-signed, ECDSA P-384. Private key stored in the secret
  manager, loaded only to sign/renew intermediates (a deliberate, audited
  CLI ceremony). Never resident in the edge runtime.
- Intermediates: 1-2 years, ECDSA P-256, path length 0, name-constrained to
  their URI namespace (`trustzone://app/...`, `trustzone://device/...`,
  `trustzone://user/...`). Keys live in a durable single-writer object
  beside the signing keys (Module 4), with the same "sign via RPC, never
  export" property.

### Issuance flows

```
workload cert:  authenticated RPC (service credential or workload identity)
                + CSR -> 24h-7d cert (Module 11)
device cert:    user session (DPoP-proven) + CSR from the device key or a
                dedicated device key -> 30-90d cert naming user and device
user cert:      reserved; user identity remains token-based until a concrete
                consumer (e.g. SSH, code signing) justifies it
```

Every issuance writes an audit row: requester identity, SAN, serial,
lifetime, public key fingerprint.

### Where DPoP keys fit vs certificates

- DPoP keys are session-binding keys: self-generated, never CA-attested,
  proven by use. They answer "is this the same device that logged in" and
  require no PKI.
- Certificates are third-party-attested identity: they answer "the platform
  vouches this key belongs to workload X" and work at the transport layer
  before any application logic.
- The planned bridge: device certificates can attest the same key used for
  DPoP (or a key in the same secure element), giving sessions a verifiable
  hardware-backed provenance (key attestation, Module 15). Until then the
  two systems stay independent and complementary.

### Revocation and rotation

- Primary control is lifetime: nothing below an intermediate lives longer
  than 90 days, workloads max 7 days.
- Active revocation: the gateway maintains a serial denylist consulted by
  the edge verification config and by the SDK's mtls handler; updates
  propagate in minutes. Full CRL/OCSP machinery is intentionally deferred -
  at this scale the denylist is sufficient and simpler.
- Intermediate compromise: remove it from edge trust config, issue a new
  intermediate from the root (ceremony), force renew-all (cheap, since
  renewal is automated). Root compromise is a rebuild-the-zone event,
  mitigated by keeping the root offline.

---

## Module 13: Authorization Handling

### Narrative

Authentication tells you who is calling; authorization decides what they may
do, and the worst designs smear that decision across every codebase. The
trust zone draws one clear line: the gateway decides what a token can carry
(coarse, scope-based, enforced at issuance), and applications decide what a
request may touch (fine, resource-based, enforced at the data). Both layers
are mandatory and neither substitutes for the other. The outcome is that
adding policy never means hunting through services, and a future move to
richer policy models slots in without rewiring authentication.

### The two layers

```
Layer 1 - gateway (issuance time):
    "may this principal hold scope S for audience A?"
    inputs: principal type (user / chained / service / workload),
            registry grants, delegation policies, federation pools
    output: the token's scope set (and act chain)

Layer 2 - application (request time):
    "may this identity, with these scopes, do this to this resource?"
    inputs: ctx.identity (sub, scopes, actorChain), request payload,
            application data (ownership, state)
    output: allow / deny per the application's own rules
```

The server SDK enforces the floor of layer 2 automatically (method scope
membership, Module 6). Application-level checks beyond that are ordinary
code, but they receive a fully resolved identity so they never re-parse or
re-verify anything.

```
example (application code):
    handler GetStatement(ctx, req):
        # scope ledger/AccountService.GetStatement already enforced
        acct = db.account(req.account_id)
        if acct.owner != ctx.identity.sub
           and not ctx.identity.scopes.has("ledger/admin"):
            deny(permission_denied, audited=true)
```

### Current policy model

- Users: one allowlisted operator; user tokens are grantable all registered
  scopes for any audience. The structure already supports per-user scope
  grants in the registry (a `user_grants` table mirroring delegations) the
  day a second human appears - the gateway's step 3 issuance rule (Module 4)
  is written against "entitled scopes," not "all scopes."
- Services: exactly the scopes registered to the client.
- Chains: exactly the delegation grants (Module 7).
- Workloads: exactly the pool's allowed scopes (Module 10).

### Evolution path

1. Per-user grants (next): registry table + admin CLI verbs; no token or
   SDK changes, since tokens already carry expanded scopes.
2. Attribute-based conditions (later): grants gain optional condition
   expressions evaluated at issuance (time of day, network context from
   Module 15, device posture). Still issuance-time; tokens stay simple.
3. Relationship-based authorization (future module): for applications with
   shared data, a central relationship store ("subject U is editor of
   resource R") queried by applications at request time through a generated
   client - layer 2 tooling, deliberately separate from the token layer.
   The design rule that keeps this clean: tokens authorize methods,
   relationships authorize resources; never encode resource ids in scopes.

### Security requirements

- Layer 2 denials are audited with the same richness as layer 1 (the SDK
  ships a `deny()` helper that writes to the audit stream).
- No application may grant or expand scopes; anything an application wants
  to allow beyond the token is its own resource-level decision and never
  changes what the token claims.
- Policy data (grants, delegations, pools) is mutated only through audited
  admin RPCs driven by the version-controlled manifest.

---

## Module 14: External API Access on Behalf of Users

### Narrative

Sooner or later a zone application needs to act on a user's behalf outside
the zone: read their mail at a workspace suite provider, file an issue, post
a message. The naive approach scatters third-party refresh tokens across
services, each with its own half-correct refresh logic and zero audit. This
module centralizes the problem in one integration broker: a registered
application that owns every outbound grant, stores them in the secret
service, refreshes them server-side, and hands zone applications short-lived
access on a per-request, per-scope, audited basis. The outcome is that
third-party credentials have exactly one home, consent is explicit and
revocable, and "what can the zone do at provider P" has one answer.

### Broker responsibilities

- OAuth2 client integrations: run authorization code flows against external
  providers, store grants, refresh access tokens, serve them to authorized
  zone applications.
- API-token integrations: vault static third-party API tokens (for
  providers without OAuth), optionally proxy calls so the token never
  leaves the broker, and track rotation.
- Consent and inventory: record which zone application requested which
  external scopes for which user, and surface it (`cli integrations list`).
- Audit: every grant creation, refresh, retrieval, and revocation.

### Data model

```
table integrations(        # one per external provider config
    name,                  # e.g. workspace-suite
    kind,                  # oauth2 | api_token
    auth_url, token_url, client_id,
    client_secret_ref,     # secret-ref://services/broker/<name>/client_secret
    scopes_available)

table grants(
    id, integration, subject,        # zone user the grant belongs to
    external_account,                # provider-side identity
    scopes_granted,
    refresh_token_ref,    # secret-ref://users/<sub>/<integration>/refresh
    access_cache_ref,     # short-lived, optional
    created_at, last_refreshed_at, revoked_at)

table grant_access(       # which zone apps may use which grants
    integration, audience, scopes_allowed)
```

Token values live only in the secret service under the `users/` namespace
(Module 9); broker tables hold references.

### Flows

```
flow connect_integration(user, integration, scopes):   # via CLI or web
    url = broker.BeginAuthorization(integration, scopes)
        -> provider auth URL, state bound to user's zone identity
    user completes provider consent in browser
    broker callback: exchange code, fetch external_account id,
        store refresh token via secret service (users/<sub>/...),
        create grant row, audit "grant.create"

flow get_external_token(caller_ctx, integration, scopes):
    # caller is a zone application holding a chained token for the broker
    require caller_ctx.identity has scope
        "broker/TokenService.GetExternalToken"
    require grant_access allows (caller audience, integration, scopes)
    require subject of caller_ctx (the user in the chain) has a live grant
    tok = cached access token if fresh else:
        refresh = secret_service.User.ResolveGrant(ref)
        tok = provider.token_endpoint(refresh_token=refresh)
        if provider rotates refresh tokens: update ref'd value
    audit "grant.use" { caller chain, integration, scopes }
    return { access_token: tok, expires_in }   # never the refresh token
```

Zone applications always reach the broker with a chained token (Module 7),
so the user is in the actor chain and the broker can match the grant to the
real subject - a service can never fetch external tokens for an arbitrary
user.

### Proxy mode for vaulted API tokens

For `api_token` integrations the broker can act as a forward proxy:

```
POST broker/ProxyService.Invoke { integration, method, path, body }
    -> broker injects the vaulted token, performs the call,
       returns the response; the token never leaves the broker
```

Proxy mode is preferred whenever the consumer does not need streaming or
provider SDK features, because it gives per-call audit and central rate
limiting for free.

### Security requirements

- The broker is the only application with `users/` secret namespace access.
- External refresh tokens are never returned by any RPC under any
  circumstance; only short-lived access tokens or proxied responses leave.
- Revocation (`cli integrations revoke`) deletes the grant, tombstones the
  secret, and calls the provider's revocation endpoint when one exists.
- Provider client secrets follow the standard service secret lifecycle
  (Module 9); broker outbound scopes requested at consent are the minimum
  the requesting feature declared, surfaced to the user at consent time.

---

## Module 15: Future State and Gap Analysis

### Narrative

A credible zero-trust story is honest about what it does not yet do. This
module inventories the gaps between the platform as designed above and a
defensible end state, ordered roughly by risk reduction per unit of effort.
Each item names the gap, the risk it leaves open today, and the intended
design direction, so future work starts from a decision rather than a blank
page.

### Anomaly detection on audit streams

- Gap: the audit log is written and queryable but nothing watches it.
- Risk: reuse detection and denials fire, but a slow-and-low attacker
  generating plausible traffic is invisible until manually reviewed.
- Direction: stream audit rows to a small analysis worker maintaining
  per-principal baselines (issuance rate, audience set, geo/ASN of client
  metadata); alert on new audience-for-principal, impossible travel,
  chain-depth anomalies, off-hours admin RPCs. Alerts page the operator
  through an existing notification application. This is the highest-value
  gap because all the data already exists.

### Device posture and continuous verification

- Gap: a session, once established, is trusted for its lifetime regardless
  of device state beyond the initial WARP check at enrollment and tier
  policy requirements.
- Partial today: `organization.yaml` configures account-level WARP posture
  rules, tier `require_posture` on Access policies, and tier3 enroll policies;
  bootstrap applies these via the Cloudflare Go SDK. Continuous re-check at
  every session refresh is not yet enforced.
- Risk: a compromised-but-enrolled device retains access for up to 12
  months of refreshes.
- Direction: attach posture claims at refresh time - OS version, disk
  encryption, screen lock - collected by a lightweight agent or by the
  identity-aware proxy's device client where available. Refresh policy in
  the gateway can then require fresh posture (e.g. every 24h) and downgrade
  or revoke sessions that fail. Continuous verification means policy is
  re-evaluated at every refresh, not only at login - the 5-minute access
  token lifetime makes refresh the natural enforcement beat.

### Key attestation

- Gap: DPoP keys are software keys; the gateway cannot distinguish a key in
  a secure enclave from one in a readable file.
- Risk: malware with file access can copy the CLI device key and clone the
  session elsewhere.
- Direction: prefer platform secure-element storage (OS keychain APIs,
  WebAuthn/passkey-backed signing in browsers) and have enrollment carry an
  attestation statement where the platform provides one. The gateway records
  attestation level per session and policy can require hardware-backed keys
  for admin scopes. The device CA (Module 12) is the natural anchor.

### Session binding to network context

- Gap: sessions are bound to keys, not to anything about where requests
  originate.
- Risk: a fully compromised device gives the attacker everything the
  device has, from anywhere.
- Direction: record client network metadata per refresh; allow policy like
  "admin scopes only from previously seen networks" or "step-up (fresh
  browser login) on network change." Soft signals feeding the anomaly
  module first, hard policy later - hard network binding conflicts with
  mobility and should stay opt-in per scope.

### Secrets scanning and hygiene

- Gap: the manifest linter (Module 5) catches secrets in manifests, but
  nothing scans the wider repository, generated configs, or audit metadata
  for leaked values.
- Risk: a value pasted into the wrong file defeats the reference
  architecture silently.
- Direction: pre-commit and CI scanning with provider-format detectors plus
  entropy heuristics; a periodic job that resolves every registered
  secret-ref and searches for its value fingerprint (hashed n-grams, never
  plaintext) across repository and logs; rotation triggered automatically
  on any hit.

### Break-glass procedures

- Gap: if the identity-aware proxy, the upstream IdP, or the gateway's own
  auth path is down, the operator currently has no in-band way to
  administer the zone.
- Risk: an outage of an external dependency locks the operator out exactly
  when intervention is needed.
- Direction: a sealed break-glass credential - a long-lived, heavily scoped
  service credential stored offline (printed or in a separate vault),
  accepted by the gateway only when a break-glass flag has been enabled via
  the edge platform's own console, with every use loudly audited and an
  enforced post-use rotation. Tested quarterly like any disaster recovery
  path.

### Supply chain and deploy integrity

- Gap: deploys trust the operator's machine; generated code and worker
  bundles are not attested.
- Risk: a compromised dev machine can ship arbitrary code under delegated
  provider OAuth.
- Direction: build in CI under workload identity (Module 10), produce
  signed provenance for bundles, and have the deploy service verify
  provenance before upload. The operator's machine then needs only the
  ability to trigger CI, not to push code directly.

### Multi-user readiness

- Gap: several designs assume a single operator (allowlist of one,
  all-scopes user grants).
- Risk: none today; cost is rework if a collaborator joins.
- Direction: already mostly paid for - per-user grants (Module 13), session
  families per user (Module 4), and per-user secret namespaces (Module 9)
  are designed in. Remaining work is admin tooling: invitations, role
  bundles (named scope sets), and per-user audit views.

### Prioritized roadmap

| Order | Item | Effort | Risk reduced |
|---|---|---|---|
| 1 | Audit anomaly detection | M | High - turns existing data into detection |
| 2 | Secrets scanning | S | High - protects the reference architecture |
| 3 | Break-glass procedure | S | High - availability of control plane |
| 4 | Key attestation / keychain storage | M | Medium-high - device key theft |
| 5 | mTLS rollout (Module 11) + workload CA | M | Medium - defense in depth |
| 6 | Workload identity pools (Module 10) | M | Medium - removes CI secrets |
| 7 | Integration broker (Module 14) | L | Medium - safe external access |
| 8 | Device posture at refresh | L | Medium - continuous verification |
| 9 | Deploy provenance | M | Medium - supply chain |
| 10 | Web client SDK (Module 3) | M | Enables web surface safely |

The platform's core invariants - single issuer, short lifetimes, proof of
possession, explicit delegation, references over values, audit everything -
do not change as these land. Each item strengthens an existing principle
rather than introducing a new kind of trust, which is the test every future
addition must pass.


