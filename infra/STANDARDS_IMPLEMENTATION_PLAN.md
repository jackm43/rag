# Standards Implementation Plan

The concrete end state is defined in [TARGET_STATE.md](./TARGET_STATE.md).
This plan is the replacement path from the current repository to that state:
old client contracts are deleted when a stronger standard surface exists.

## Phase 1: Gateway Standards Surface

- Add `/.well-known/oauth-authorization-server` and
  `/.well-known/openid-configuration`.
- Add a standards-facing `/oauth/token` endpoint for:
  `authorization_code`, `refresh_token`, and
  `urn:ietf:params:oauth:grant-type:token-exchange`.
- Replace token/session Connect RPCs with form-encoded OAuth endpoints backed
  by shared internal grant functions.
- Add `/oauth/revoke` and publish it through authorization-server metadata and
  gateway discovery.
- Add OAuth error responses (`invalid_request`, `invalid_grant`,
  `invalid_scope`, `unauthorized_client`) instead of leaking Connect error
  shapes on OAuth endpoints.
- Add protected resource metadata for each application audience.

## Phase 2: DPoP Completion

- Require `ath` on every token-bearing DPoP proof.
- Add DPoP nonce support:
  respond with `use_dpop_nonce` and `DPoP-Nonce`, cache accepted nonces, and
  retry automatically in Go and web clients.
- Add server-side JTI replay protection keyed by proof thumbprint and request
  target for the accepted proof window.
- Add conformance tests for method, URL normalization, stale proof, wrong key,
  wrong `ath`, nonce retry, and replay.

## Phase 3: Generated Application Model

- Generate a worker entrypoint for every service app:
  `createPlatformRpcWorker({ serviceName, register })`.
- Generate named service clients per RPC service instead of only a generic
  `serviceClient`.
- Generate named web clients per RPC service and app-level auth bootstrap
  helpers.
- Generate BFF worker config from manifest delegations for web apps.
- Generate `policy.generated.md` per app containing resources, scopes,
  delegations, trust zone, provider auth mode, and impersonation support.
- Add tests that fail if an application worker calls another internal RPC via
  raw `fetch` instead of the generated service client.

## Phase 4: Web Auth Package

- Add `TrustZoneWebAuth.bootstrap()` to fetch discovery, initialize DPoP, and
  recover/refresh sessions in one call.
- Add React-neutral route guards:
  `requireSession`, `optionalSession`, and `handleCallback`.
- Add small React bindings:
  `AuthProvider`, `useAuth`, and `AuthBoundary`.
- Keep DPoP private-key handling inside IndexedDB/non-extractable Web Crypto;
  only expose proof generation through SDK-owned transports.
- Add a visible state machine for `none`, `loading`, `active`,
  `needs_login`, and `login_redirect`.

## Phase 5: Authorization and Delegation Hardening

- Make actor-chain validation a mandatory SDK receiver policy with no opt-out
  for registered application RPCs.
- Split user impersonation consent from ordinary service delegation and emit a
  typed audit event for each consented exchange.
- Add registry diff checks that fail deployment when generated proto scopes and
  manifest scopes diverge.
- Add trust-zone policy checks before issuing service credentials and provider
  OAuth clients.

## Phase 6: Observability Standard

- Rename transport span attributes toward OpenTelemetry semantic conventions:
  `rpc.system`, `rpc.service`, `rpc.method`, `server.address`,
  `http.request.method`, `url.path`, and `http.response.status_code`.
- Keep platform identity attributes under a stable namespace:
  `platy.identity.kind`, `platy.identity.subject`, `platy.identity.actor_chain`,
  `platy.session.id`, `platy.client.instance`.
- Export traces through the gateway by default and keep generic OTLP export as
  a deployment option.
- Add log event schemas for `request_unauthenticated`, `request_denied`,
  `identity_exchanged`, `identity_exchange_refused`, `rpc_client`,
  `rpc_client_failed`, and `stream_completed`.

## Phase 7: OAuth/OIDC RFC Correctness

Extends Phase 1. Closes the gap between "standards-shaped" and "standards-correct"
on the gateway. See [STANDARDS_REVIEW.md](./STANDARDS_REVIEW.md) findings 9-12.

- Add a real RFC 7662 `POST /oauth/introspect` returning
  `{ active, sub, exp, scope, cnf, token_type, ... }` with client authentication.
  Today introspection is Connect-RPC only (custom `{ principal, scopes }`) yet
  authorization-server metadata advertises it as the introspection endpoint.
- Harden RFC 7009 `/oauth/revoke`: return an empty `200` body (not JSON `{}`),
  require client authentication, and honor `token_type_hint` (the Go client
  already sends it; the server ignores it).
- Emit RFC 9728 protected-resource metadata
  (`/.well-known/oauth-protected-resource`) from every application worker,
  owned by `createPlatformRpcWorker` so application authors get it for free.
- RFC 8414 correctness: reconcile `issuer` (gateway) versus
  `authorization_endpoint` (Cloudflare Access) into a coherent model; add the
  missing `*_auth_methods_supported` and `response_modes_supported` fields; and
  either issue ID tokens or stop serving `/.well-known/openid-configuration` as
  OIDC discovery.
- DPoP error semantics (extends Phase 2): a missing or invalid proof must return
  `401` with `WWW-Authenticate: DPoP error="invalid_dpop_proof"` (and
  `use_dpop_nonce` where applicable), not `invalid_grant`.
- Session grants must return the granted scope, not a hardcoded `scope: "*"`.
- Map gateway refusals to correct OAuth error codes
  (`invalid_dpop_proof`, `access_denied`) instead of leaking internal refusal
  strings into `error_description`.

## Phase 8: Go SDK Idiom and Package Structure

Aligns the Go SDK with idiomatic Go and the documented `infra/sdk/go/` layout.
See [STANDARDS_REVIEW.md](./STANDARDS_REVIEW.md) finding 13.

- Resolve the duplicate `client` package collision (`sdk/client` versus
  `sdk/oauth2/client`, aliased `oauthclient` at every import) by renaming the
  OAuth client package.
- Give `gateway.Session` a functional-options constructor and stop exporting
  mutable fields; fold the post-construction patching currently in
  `platform.NewSession` into options.
- Default `client.New`'s `HTTPClient` to `httpclient.Default()` instead of
  silently relying on `http.DefaultClient`.
- Replace error-swallowing returns (`TokenStore.Get`, `SecretStore.read`,
  `CredentialDocument` return nil/`{}` on failure) with typed/sentinel errors,
  and replace the string-prefix `IsProviderAuthorizationError` with a Connect
  error detail or typed error.
- Push `output.Fail`/`os.Exit` out of library functions (`LoadOrganization`,
  `platform.RepoRoot`) into the command layer so the SDK is composable; return
  errors instead.
- Propagate the cobra command context instead of `context.Background()` in
  `cli/internal/platform.Session()` and `roo`.
- Slim and rename `IdentityProxy` now that Terraform owns static provisioning:
  the interface should expose only the dynamic provider-OAuth surface, not the
  15-method Cloudflare-shaped bootstrap surface that was deleted in the
  Terraform reversal.
- Normalize the bootstrap-versus-GraphQL JSON tag mismatch on the discovery
  DTOs (`created_at` vs `createdAt` on one struct).

## Phase 9: gRPC/Connect Consistency

- Fix streaming auth to fail closed: outbound decorate failures on the gateway
  streaming interceptor are logged rather than returned, so a streaming RPC can
  proceed without auth headers.
- Decide proto-first metadata: either build authorization-server metadata from
  the `platy/oauth/v1/oidc.proto` messages (currently defined but unused, built
  imperatively) or delete the proto.
- Standardize worker non-RPC error bodies and remove Connect-envelope leakage on
  plain HTTP routes.
- Document the discovery-driven generic Go `client.Call` (manual Connect
  framing) versus generated stubs tradeoff; optionally generate per-app Go
  Connect clients for `roo fetch`.

## Phase 10: Consumer Interface Simplification (TS/Web)

Extends Phases 3-4 toward the [TARGET_STATE.md](./TARGET_STATE.md) outcome that
application authors write only business logic.

- Have `createPlatformRpcWorker` own auth wiring (issuer, JWKS, `stsAuthenticator`,
  `sessionChainAuthenticator`) from manifest/generated config so handlers are
  business-only; generate per-app worker entrypoints, including a hybrid variant
  for the OAuth+RPC `idp` worker and adoption by `ragbot`.
- Generate typed target accessors from manifest delegations to replace the
  hand-written `connector.ts` files and the need to know `serviceConnection`
  env shape (binding names, `*_ENDPOINT`, scope strings).
- Namespace generated clients per application to remove factory-name collisions
  (`ragbot` and `aigateway` both export `chatServiceClient`); move toward
  `ragbot.client(auth, ConfigService)`.
- Generate a `ragbot` web client and replace the raw `auth.call` Connect paths
  in `infra/applications/chat/app/DataPanel.tsx`.
- Add `TrustZoneWebAuth.bootstrap()` one-call init plus route guards and React
  bindings (completes Phase 4).
- Introduce npm workspace package names to replace deep `../../../../sdk/ts/src`
  imports; consolidate the duplicate `proxyTarget`/`proxyTargetFor`; and
  reorganize `sdk/ts/src` into `oauth2/` and `resource/` per the target layout.

## Work Completed In This Pass

- Added standards-shaped gateway metadata builders and well-known routes.
- Added DPoP `ath` signing/verification support in TS SDK and Go SDK.
- Updated TS sender-constraint checks to verify `ath` against the bearer token.
- Added a shared TS `createPlatformRpcWorker` wrapper.
- Refactored deploy, cloudflare, discovery, and aigateway worker entrypoints to
  use the shared wrapper.
- Added focused DPoP tests for access-token hash binding.
- Added [TARGET_STATE.md](./TARGET_STATE.md) with the desired repo structure,
  generated artifacts, and enforceable outcomes.
- Refactored `protoc-gen-platy-clients` to generate named service/web client
  factories instead of generic app shims.
- Generated `policy.generated.md` for proto-backed applications from proto
  services plus `applications.yaml`.
- Migrated worker and browser callers to the generated named client factories.
- Integrated the Terraform reversal: `infra/terraform` now owns the static
  Cloudflare surface (Zero Trust settings, Access policies/apps, the OIDC app,
  impersonation and bypass apps, D1, queues) and the CLI keeps only the dynamic
  surface (provider OAuth clients, registry sync, deploy). Removed `platy
  bootstrap`, the `cfauth` package, the Cloudflare `organization.go`
  provisioning, and `webclient_access.go`; updated `AGENTS.md`/`README.md`
  accordingly.
