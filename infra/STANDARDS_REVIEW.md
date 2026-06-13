# Standards Review

This review treats the platform as an OAuth/OIDC authorization server, a set of
protected resource servers, generated service clients, generated web clients,
and a CLI public client. The target is that a new application author writes
business logic and a manifest entry; generated and SDK-owned code handles
authentication, authorization, token exchange, DPoP, discovery, logging, and
tracing.

## Standards Baseline

- OAuth authorization server metadata: publish standard issuer metadata at
  `/.well-known/oauth-authorization-server` per RFC 8414.
- OIDC discovery: publish `/.well-known/openid-configuration` with compatible
  metadata for OIDC-aware clients.
- Token exchange: model delegation through RFC 8693. Platform-specific
  impersonation consent can remain an extension, but the primary request and
  response shape should stay recognizably RFC 8693.
- DPoP: implement RFC 9449 proof verification, including `htm`, `htu`, `iat`,
  `jti`, public JWK thumbprint, and `ath` when an access token is presented.
- Resource servers: treat every worker RPC surface as an OAuth protected
  resource. Authentication, scope checks, actor-chain validation, DPoP checks,
  and boundary tracing should be SDK middleware, not application code.
- Observability: emit OpenTelemetry-shaped spans with W3C trace context and
  stable semantic attributes. Application code can add domain attributes, but
  transport/auth spans should be automatic.

## Findings

1. Gateway discovery was platform-specific only.
   `GET /api/discovery` is useful for the CLI and registry graph, but it is not
   enough for standard OAuth/OIDC clients. The gateway now also exposes standard
   well-known metadata and links those documents from `/api/discovery`.

2. Token exchange is implemented behind Connect RPC rather than a conventional
   OAuth token endpoint.
   The protobuf message follows RFC 8693 closely, but the wire endpoint is
   Connect JSON. The next step is to move exchange/session operations behind a
   standards-facing `/oauth/token` endpoint and keep Connect wrappers as typed
   internal clients.

3. DPoP proof verification did not enforce `ath`.
   A proof could demonstrate possession of the bound key for a URL, but not bind
   that proof to the exact access token on the request. TS and Go SDKs now sign
   `ath` for token-bearing requests, and the TS verifier rejects mismatched
   proofs.

4. Application workers repeated security bootstrapping.
   Several workers hand-wired tracing, gateway trace export, RPC route dispatch,
   CORS, health responses, and JSON errors. That makes generated apps fragile.
   A new SDK `createPlatformRpcWorker` wrapper centralizes this pattern and the
   deploy, cloudflare, discovery, and aigateway workers now use it.

5. Web auth is conceptually strong but not packaged as an extension model.
   `BrowserAuth` owns PKCE, IndexedDB DPoP keys, refresh, and transport
   auth, which is good. It should expose composable route/page guards and
   explicit DPoP client extension points so React apps do not hand-roll auth
   state transitions.

6. Generated clients are too thin to communicate policy.
   `applications/<app>/service` and `web` clients correctly bind into SDK
   transports, but generated output should include named factory functions per
   service and generated worker/BFF entrypoints so users do not need to know
   path prefixes, scopes, bindings, or auth modes.

7. Authorization policy is mostly runtime-only.
   Scope naming, delegation grants, impersonation, provider OAuth, and trust
   zone registration live in manifests and registry tables, but there is no
   single generated policy document or compile-time view for each app. That
   makes review harder and hides drift.

8. Observability is useful but not yet a full platform standard.
   The SDK emits spans and logs, but attribute names are partly custom and there
   is no generated request/error taxonomy per application. Adopt OpenTelemetry
   semantic conventions for HTTP/RPC and keep identity attributes consistent.

9. Gateway OAuth endpoints are standards-shaped but not standards-correct.
   `/oauth/token` and `/oauth/revoke` exist with OAuth error bodies, but
   introspection is Connect-RPC only (custom `{ principal, scopes }`) while
   metadata advertises it as the introspection endpoint; revocation returns
   JSON `{}` with no client auth and ignores `token_type_hint`; protected
   resource metadata (RFC 9728) is absent; authorization-server metadata mixes
   a gateway `issuer` with a Cloudflare Access `authorization_endpoint` and omits
   several required fields; missing-DPoP maps to `invalid_grant` rather than a
   `401` DPoP challenge; and session grants return `scope: "*"`. Addressed by
   Phase 7 in [STANDARDS_IMPLEMENTATION_PLAN.md](./STANDARDS_IMPLEMENTATION_PLAN.md).

10. The Go SDK has idiom and structure debt.
    Two packages named `client` force an `oauthclient` alias everywhere;
    `gateway.Session` exposes mutable fields patched after construction;
    several stores swallow errors and return nil; `IsProviderAuthorizationError`
    parses error-message prefixes; and `output.Fail`/`os.Exit` live inside
    library functions, making the SDK hard to embed. Addressed by Phase 8.

11. Connect/gRPC behaviour is inconsistent at the edges.
    The gateway streaming interceptor logs (rather than returns) outbound
    decorate failures, so a stream can proceed unauthenticated; the
    `platy/oauth/v1/oidc.proto` messages are defined but unused (metadata is
    built imperatively); and plain HTTP routes return ad hoc error bodies.
    Addressed by Phase 9.

12. Application authors still hand-wire too much in TypeScript.
    Worker auth (issuer, JWKS, authenticators) is duplicated per worker;
    `serviceConnection` leaks env shape; generated factories collide by name
    across apps; the browser still hits raw Connect paths where a web client is
    missing; and there is no one-call browser bootstrap or route guard. Addressed
    by Phase 10.

13. Static infrastructure now lives in Terraform, not the CLI.
    `infra/terraform` is the source of truth for the static Cloudflare surface
    (Zero Trust, Access policies/apps, OIDC app, impersonation/bypass apps, D1,
    queues). The CLI keeps only the dynamic surface (provider OAuth clients,
    registry sync, deploy), which shrinks the former Cloudflare-shaped
    `IdentityProxy` to the provider-OAuth surface (see Phase 8).

## Target Patterns

- `platy app create <name>` scaffolds proto, manifest, worker entrypoint,
  optional web BFF, tests, and a generated policy document.
- Worker entrypoints use one SDK wrapper:
  `createPlatformRpcWorker({ serviceName, register })`.
- BFF entrypoints use one SDK wrapper:
  `createWebBffWorker({ app, targets })`.
- Browser apps use one auth object and generated clients:
  `const auth = await BrowserAuth.bootstrap(...)`;
  `const client = ragbot.client(auth, ConfigService)`.
- Pages/components use SDK route guards instead of ad hoc checks:
  `auth.requireSession()` for loaders and `AuthBoundary` for React.
- Service-to-service calls always use generated service clients over
  `serviceConnection`; direct `fetch` to internal RPC paths is disallowed by
  convention and lint/test checks.
- Gateway metadata, token exchange, session creation, introspection, and
  revocation should all have standards-facing HTTP endpoints plus typed Connect
  clients for internal use.

## References

- RFC 7009: OAuth 2.0 Token Revocation.
- RFC 7662: OAuth 2.0 Token Introspection.
- RFC 8414: OAuth 2.0 Authorization Server Metadata.
- RFC 8693: OAuth 2.0 Token Exchange.
- RFC 9449: OAuth 2.0 Demonstrating Proof of Possession.
- RFC 9728: OAuth 2.0 Protected Resource Metadata.
- OpenID Connect Discovery 1.0.
- Go module layout and package conventions (https://go.dev/doc/modules/layout).
