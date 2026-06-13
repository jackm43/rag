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
