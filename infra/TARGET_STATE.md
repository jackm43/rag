# Target State

The platform should feel like a small opinionated framework, not a collection of
examples. A new application author should define a proto surface and manifest
entry, then fill in business handlers. Everything else should be generated or
SDK-owned.

## Outcomes

- Application authors do not hand-wire auth, DPoP, token exchange, CORS,
  tracing, route prefixes, service bindings, or browser session plumbing.
- Gateway auth surfaces are standards-shaped first: OAuth/OIDC metadata,
  OAuth token endpoint, DPoP verification, introspection, revocation, and
  protected-resource metadata.
- Generated artifacts are strong enough to review: each app has named clients,
  a generated policy document, generated BFF config where applicable, and a
  generated worker entrypoint for normal RPC apps.
- Worker-to-worker calls always use generated service clients over SDK
  connectors. Raw internal RPC `fetch` calls are treated as a standards
  violation.
- Web apps use one browser auth package with route/page guards and generated
  clients. Pages do not construct DPoP proofs, token exchanges, or audience
  tokens.
- Logs and traces follow one taxonomy and OpenTelemetry-compatible attribute
  names, with platform identity fields consistently namespaced.
- Static Cloudflare infrastructure (Zero Trust, Access policies/apps, the OIDC
  app, impersonation/bypass apps, D1, queues) is declared in `infra/terraform`
  and derived from the manifests; the CLI owns only the dynamic surface
  (provider OAuth clients, registry sync, deploy).

## Target Repo Structure

```text
infra/
  terraform/                     # static Cloudflare infra (Zero Trust, Access, D1, queues)
  proto/
    platy/
      oauth/v1/                  # OAuth/OIDC/DPoP wire shapes
      resource/v1/               # protected-resource metadata shapes
    <app>/v1/                    # first-party application RPC contracts

  applications/
    applications.yaml            # desired registry, routes, delegations, trust zones
    <app>/
      policy.generated.md        # generated review artifact from proto + manifest
      client/                    # generated Go Connect client
      server/                    # generated TS protobuf-es descriptors
      service/                   # generated TS worker client factories
      web/                       # generated TS browser client factories
      worker/
        src/
          index.ts               # generated or thin SDK wrapper
          services.ts            # application business handlers
          types.ts               # worker env and local types

  sdk/
    go/
      oauth2/                    # OAuth public/confidential client runtime
      gateway/                   # gateway session and token exchange client
      client/                    # discovery-driven CLI RPC invoker
      apps/<app>/                # rare app-specific CLI clients
      extensions/<provider>/     # registration/bootstrap helpers
    ts/
      oauth2/                    # token, DPoP, metadata helpers for workers
      resource/                  # protected resource verification helpers
      auth/                      # authenticators, BFF, session proxy
      authz/                     # scopes, delegations, protect
      client/                    # service connector transport
      worker/                    # generated-app worker wrappers
      otel/                      # tracing and logs
    web/
      auth/                      # browser session, DPoP, route guards
      react/                     # optional React bindings
      transport/                 # generated web client transport

  cli/
    cmd/app/create               # scaffolds app from archetypes
    internal/clientgen           # named service/web clients + policy docs
    internal/bffgen              # generated BFF worker and wrangler config
```

## Generated Artifacts

For an app with `ConfigService` and `LeaderboardService`, generated service
bindings should look like:

```ts
const config = configServiceClient(connection, identity);
const leaderboard = leaderboardServiceClient(connection, identity);
```

Generated browser bindings should mirror that:

```ts
const config = configServiceClient(auth);
```

Each app also gets `policy.generated.md` with:

- application name, endpoint, worker, trust zone, provider auth mode
- service/client generation flags
- resources and method scopes from proto
- delegations and delegated scopes from manifest
- secret names, without secret values
- impersonation status and post-deploy hooks

## Application Author Flow

1. `platy app create invoices --kind service`
2. Edit `infra/proto/invoices/v1/*_service.proto`.
3. Implement only handlers in `infra/applications/invoices/worker/src/services.ts`.
4. Run `platy app sync`.
5. Run `platy deploy invoices`.

No step should require knowing how to create a DPoP proof, exchange a token,
validate actor chains, attach trace headers, or form Connect RPC paths.

## Enforcement

- Codegen is the source of app bindings and policy artifacts.
- Tests fail when generated files are stale.
- Lint/tests fail when application workers import raw target service descriptors
  and call `connectorServiceClient` or `fetch` directly for internal RPCs.
- Gateway conformance tests cover OAuth metadata, token exchange, DPoP `ath`,
  nonce/replay handling, introspection, revocation, and resource metadata.
