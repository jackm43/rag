# Protocol buffer standards

Contracts for the platform are protobuf-first and served over Connect-RPC (JSON on the wire). This document describes how schemas are organized, how they relate to generated code and the hand-written SDK, and how to add or import new services.

External references:

- [Protobuf style guide](https://protobuf.dev/programming-guides/style/)
- [Protobuf best practices](https://protobuf.dev/best-practices/dos-donts/)

## Layout

```
infra/proto/
  buf.yaml                 # buf module (lint STANDARD, breaking FILE)
  <app>/                   # one directory per registered application
    v1/                    # package <app>.v1 — RPC surface for that worker
      types.proto          # optional: shared messages for this app only
      foo_service.proto    # one service (+ its request/response messages) per file
```

OAuth/OIDC and DPoP wire shapes are not modelled as protobuf: the gateway
serves them as standards-shaped HTTP (RFC 8414/8693/9449/7009/7662/9728) and the
SDKs verify them directly, so there is no shared `platy/` proto package today.
Add one only if a contract must be shared across applications (see
[Adding shared platform messages](#adding-shared-platform-messages-platy)).

Generated output (do not edit by hand):

| Source | Go client (Connect) | TypeScript server (protobuf-es) | Platform bindings |
|--------|---------------------|----------------------------------|-------------------|
| `<app>/` | `infra/applications/<app>/client/` | `infra/applications/<app>/server/` | `service/`, `web/`, `policy.generated.md` |

The application name in `infra/applications/applications.yaml`, the proto directory name (`infra/proto/<app>/`), and the protobuf package prefix (`<app>.v1`) must all match. `platy dev generate` and `platy app register` assume this 1:1 mapping.

Hand-written runtime libraries live separately under `infra/sdk/go/`, `infra/sdk/ts/`, and `infra/sdk/web/`. They implement cross-cutting behaviour (token verification, policy, transports, logging) that is intentionally not expressed in `.proto` files. See [Relationship to the SDK](#relationship-to-the-sdk).

## Naming and file rules

Follow the [style guide](https://protobuf.dev/programming-guides/style/) unless noted below.

- **Files**: `lower_snake_case.proto`. Prefer `<service_name>_service.proto` for RPC services.
- **Packages**: `lower_snake_case` dotted paths; application packages are `<app>.v1`. Shared platform packages, if ever needed, live under `platy/`.
- **Messages / services**: `TitleCase` (`ChatRequest`, `IdentityService`).
- **Fields**: `snake_case`. Repeated fields use plural names (`repeated string scopes`).
- **Enums** (when needed): type `TitleCase`, values `UPPER_SNAKE_CASE` with a `*_UNSPECIFIED = 0` first value.
- **Imports**: use fully qualified paths for other packages (`import "idp/v1/types.proto";`). For messages in another file of the same package, still add an explicit import.
- **One service per file** ([1-1-1 rule](https://protobuf.dev/best-practices/dos-donts/#define-message-types-in-separate-files)): put the `service` block and its dedicated request/response messages together. Extract shared messages into `types.proto` (or similar) when multiple services in the same app reuse them.
- **Evolution**: never reuse field numbers; `reserved` deleted fields and enum values; do not change field types; avoid `required`; prefer `optional` or `repeated` with documented API contracts in comments.

Run `buf build infra/proto` and `buf lint infra/proto` before opening a PR.

## Code generation

```bash
# all applications
./infra/scripts/generate.sh

# one application
./infra/scripts/generate.sh idp

# protobuf + typed web/service client wrappers
platy dev generate <app>
```

## Adding a new application

1. **Create protos** under `infra/proto/<app>/v1/`. Start with one `*_service.proto` file per RPC service. Set `package <app>.v1;`.
2. **Declare the application** in `infra/applications/applications.yaml` (endpoint, worker, wrangler config path, delegations, `web_client` / `service_client` flags, secrets, provider settings).
3. **Implement the worker** at `infra/applications/<app>/worker/`. Normal RPC workers use the SDK worker wrapper and put business handlers in `src/services.ts`.
4. **Generate code**: `platy app register <app>` (or `platy app sync`) registers the audience, resources, scopes, and delegations in the gateway registry, issues service credentials, and runs codegen.
5. **Deploy**: `platy deploy <app>`.

Scopes are derived automatically at registration from service and method names: `<app>/<Service>.<Method>` (e.g. `ragbot/ConfigService.ListConfig`).

## Adding a service to an existing application

1. Add `infra/proto/<app>/v1/<new>_service.proto` with the `service` and its messages.
2. If multiple services share new message types, add or extend `types.proto` and import it from the service files.
3. Run `buf build infra/proto --path infra/proto/<app>` to verify compilation.
4. Regenerate: `platy dev generate <app>`.
5. Implement handlers in the worker and register the router.
6. Re-register so the gateway picks up new methods: `platy app sync` (updates resources/scopes when the proto surface changed).

Do not add RPC methods by editing generated `*_pb.ts` / `*.pb.go` files.

## Adding shared platform messages (`platy/`)

There are no shared `platy/` protos today: OAuth/OIDC/DPoP are HTTP standards
served by the gateway, not protobuf contracts. Add `infra/proto/platy/` only if
a message type must genuinely be shared across multiple applications and is not
owned by a single worker.

- Keep package names short (e.g. `foo.v1`, not `platy.foo.v1`) so RPC signatures stay stable when imported by an application package.
- File paths include `platy/` so codegen and imports distinguish platform types from application types.
- Do not add a `platy` entry to `applications.yaml`; nothing deploys as the `platy` application.
- Re-add a generation step for the `platy` tree in `generate.sh` (it was removed when the tree became empty) and regenerate any importer.

## Importing third-party protobuf

Prefer owning the RPC surface in this repository and treating external APIs as implementation details behind a provider-connector worker (see `cloudflare`). When you must import foreign `.proto` files:

1. **Vendor** under `infra/proto/third_party/<vendor>/` (create this tree when needed). Do not mix vendor files into `<app>/v1/` directories.
2. **Pin** with a `buf.yaml` `deps` entry or a git submodule; record the upstream version in the commit message.
3. **Lint** with `buf lint` — fix or ignore rules only in a `buf.yaml` `lint.ignore` block scoped to the vendor path.
4. **Wrap, do not expose raw vendor RPCs** unless the worker is a thin pass-through connector. Define a first-party `package <app>.v1` service whose messages map to the subset you actually support; keep vendor types internal to the worker adapter layer.
5. **Packages**: if the upstream `go_package` / package name conflicts, fork the `.proto` with a new `package` and document the divergence. Never register a third-party package prefix as a platform application audience.
6. **Generate** only the first-party app path through `generate.sh`; vendor protos compile as dependencies of that path via imports.

If the upstream spec uses gRPC and this platform uses Connect, the generated Connect handlers are still valid; callers use Connect JSON or connect-go clients, not native gRPC stubs.

## Converting OpenAPI to protobuf

Design in protobuf when you control both ends. OpenAPI import is a bootstrap tool, not the source of truth.

**When to convert**

- Wrapping an existing HTTP JSON API as a new provider-connector application.
- Exploring a vendor surface before cutting a narrow platy contract.

**Workflow**

1. Obtain the OpenAPI document (file or URL).
2. Convert with [buf convert](https://buf.build/docs/reference/cli/buf_convert) or `protoc-gen-openapi` in reverse (community tools vary; pin one approach in the PR). Expect manual cleanup.
3. Place the result under `infra/proto/third_party/<vendor>/` or distill into a new `<app>/v1/*_service.proto`.
4. **Normalize** to platform conventions: `TitleCase` services, `snake_case` fields, one service per file, delete unused operations, replace OpenAPI `oneOf` hacks with explicit messages.
5. **Map HTTP semantics explicitly** in the worker — Connect-RPC does not preserve OpenAPI path layout. The proto `service` name becomes `/<app>.v1.<Service>/<Method>` over POST.
6. **Drop or redesign** features that do not map cleanly:
   - cookie/session auth → gateway STS tokens and delegations
   - arbitrary query-string polymorphism → explicit request messages
   - file uploads → `bytes` fields or separate upload RPCs
7. Run `buf build`, implement the worker adapter that translates Connect requests to the vendor HTTP client, register the app.

Keep the OpenAPI document in version control (outside `infra/proto/`) for drift review; the `.proto` files in this repo are authoritative for platform RPCs.

## Relationship to the SDK

Four locations, four roles. None of them is a 1:1 mirror of `infra/proto/` — each layer answers a different question.

| Layer | Location | Question it answers |
|-------|----------|---------------------|
| Contracts | `infra/proto/<app>/` | What messages and RPCs exist on the wire? |
| Generated bindings | `infra/applications/<app>/client\|server/` | What are the typed stubs for those contracts? |
| Go CLI SDK | `infra/sdk/go/` | How do `platy` / `roo` authenticate, discover, and call RPCs? |
| Worker SDK | `infra/sdk/ts/`, `infra/sdk/web/` | How do workers and browsers verify tokens, enforce policy, and chain identity? |

Generated application code never lives under `infra/sdk/go/`. That tree is hand-written runtime only.

### Go SDK layout (`infra/sdk/go/`)

Top-level packages are grouped by **role**, not by proto directory name. Think in four buckets:

**Platform** — cross-cutting runtime used by every CLI; maps conceptually to the auth gateway (`idp`):

| Package | Role | Proto / generated counterpart |
|---------|------|--------------------------------|
| `oauth2/oauthclient`, `oauth2/token` | Browser PKCE, DPoP, token store, transport | OAuth/OIDC/DPoP HTTP standards (no protobuf) |
| `gateway/` | Gateway session, STS exchange, impersonation | `idp/v1` Connect clients in `applications/idp/client/` |
| `identity/` | Structured logging for principals and token exchange | `idp.v1.Principal` shape (helpers only, not generated) |
| `secrets/` | 1Password + file secret providers | none |
| `trace/` | Traceparent propagation for CLI outbound calls | none |
| `httpclient/` | Shared HTTP client defaults | none |
| `platform/` | Wires the above for `platy` / `roo` bootstrap | none |

**Client** — generic outbound RPC transport:

| Package | Role |
|---------|------|
| `client/` | Discovery-driven `Fetch`: resolve endpoint, acquire audience token, Connect JSON |

**Apps** — hand-written clients for a specific registered application (when generic `client/` is not enough):

| Package | Role | Proto counterpart |
|---------|------|-------------------|
| `apps/discovery/` | GraphQL discovery read-model client + document types | `discovery/v1` (not `idp.v1.DiscoveryService`) |

Import path: `jsmunro.me/platy/sdk/apps/discovery` (package name remains `discovery`).

Add new `apps/<name>/` packages when a CLI needs typed, app-specific client logic beyond `client.Fetch` and the generated `applications/<name>/client` stubs.

**Extensions** — provider- or vendor-specific helpers used during registration/bootstrap, not worker RPC handlers:

| Package | Role |
|---------|------|
| `extensions/cloudflare/` | Scope normalization for Cloudflare provider OAuth during `platy app register` |

Import path: `jsmunro.me/platy/sdk/extensions/cloudflare` (package name remains `cloudflare`).

Add new `extensions/<provider>/` packages for similar registration-time or bootstrap-only logic. Do not put worker implementation code here — that belongs in `infra/applications/<app>/worker/`.

Platform packages stay at the module root (not under `platform/`) so import paths stay short — `jsmunro.me/platy/sdk/gateway`, not `jsmunro.me/platy/sdk/platform/gateway`. The `platform/` package is only CLI bootstrap wiring. This matches common Go module layout: one package per directory, package name equals the last path element, avoid gratuitous nesting for shared libraries ([Go module conventions](https://go.dev/doc/modules/layout)).

```
infra/sdk/go/
  oauth2/                  platform auth client (platy/oauth)
  gateway/                 platform session (idp client)
  identity/                platform logging
  secrets/                 platform
  trace/                   platform
  httpclient/              platform
  platform/                CLI bootstrap wiring
  client/                  generic RPC client
  apps/
    discovery/             app-specific CLI client
  extensions/
    cloudflare/            provider registration helper
```

### TypeScript worker SDK (`infra/sdk/ts/`)

Workers do not import `infra/sdk/go/`. The TS layout is policy- and connector-oriented:

| Package | Role | Go analogue |
|---------|------|-------------|
| `verify/` | JWT, DPoP crypto, webhooks | `oauth2/client/dpop` + gateway verification |
| `authz/` | Delegations, `protect`, scopes | (no dedicated Go worker SDK) |
| `auth/` | `sessionProxy`, authenticators | `gateway/` session patterns |
| `client/` | Connector transport, `chainExchange` | `client/` + `gateway/` |
| `identity/` | Principal logging | `identity/` |
| `provider/` | Provider API connector | n/a in Go SDK |
| `otel/` | Worker tracing | `trace/` |

**TS parity gap**: Go has `oauth2/`; TS still keeps DPoP and token-type constants under `verify/`. New OAuth client code in TS should move toward `oauth2/client` and `oauth2/token` to match Go.

### Web SDK (`infra/sdk/web/`)

Browser-only: DPoP session (`TrustZoneWebAuth`), `webTransport` / `webClient` factories bound to generated `applications/<app>/web` clients.

### Outbound clients (shared, not per-app)

Every caller uses one shared client stack. Per-application directories under `infra/applications/<app>/service` and `/web` are **generated thin bindings** over that stack — not separate client implementations.

| Runtime | Shared library | Generated per app | Call pattern |
|---------|----------------|-------------------|--------------|
| Workers (TS) | `infra/sdk/ts/src/client/` — `serviceConnection`, `connectorServiceClient`, `chainExchange`, `createClient` | `applications/<app>/service/index.ts` | `fooServiceClient(serviceConnection(env, target), identity)` |
| Browsers | `infra/sdk/web/` — `webClient`, `webTransport` | `applications/<app>/web/index.ts` | `fooServiceClient(auth, options)` |
| CLI (Go) | `infra/sdk/go/client/` — discovery-driven `Call` / `StreamCall` for `roo fetch`; `gateway.Session` for token exchange and impersonation | `applications/idp/client/` (gateway RPCs only) | `roo fetch …` |
| External HTTP APIs | `infra/sdk/ts/src/provider/` — `providerApiClient` | none | OAuth or static token injection on outbound fetch |

Cross-cutting behaviour lives only in the shared libraries:

- authenticate the caller and chain identity to the target audience
- attach the minted STS token (and DPoP where required)
- emit `rpc_client` / `rpc_client_failed` boundary logs
- propagate trace context

Generated client bindings are named per service. Do not call a generic service
descriptor from application code when a named generated factory exists.

**Do not** hand-write a new HTTP or Connect client inside an application worker. Wire `serviceConnection` once, import the generated factory, call the RPC.

**Do not** regenerate or copy connector logic into `applications/<app>/service` — `platy dev generate` already emits the factory list from proto services.

**When `apps/<app>/` is appropriate (Go CLI only):** add a package there only when the CLI needs app-specific client logic that `client.Call` cannot express — today only `apps/discovery/` (GraphQL query strings, in-process cache, document types). Workers and browsers should not get parallel `apps/` client packages; they use the TS `client/` connector.

### Rules

- Wire shapes live in `.proto`; generated stubs in `applications/<app>/client|server/`; runtime behaviour in `infra/sdk/`.
- Do not hand-write request/response structs that codegen already provides.
- Do not add generated `.pb.go` / `_pb.ts` files under `infra/sdk/go/` or `infra/sdk/ts/`.
- When adding a new **platform** concern shared by CLIs, add under the platform bucket (or `oauth2/` if it is OAuth-client runtime).
- When adding a new **app-specific CLI client**, add `infra/sdk/go/apps/<app>/`.
- When adding **registration/bootstrap** helpers for an external provider, add `infra/sdk/go/extensions/<provider>/`.

## Checklist (new RPC)

- [ ] Proto file under `infra/proto/<app>/v1/<service>_service.proto`
- [ ] `package <app>.v1;`
- [ ] `buf build` / `buf lint` clean
- [ ] `platy dev generate <app>`
- [ ] Worker mounted through `createPlatformRpcWorker` or `createWebBffWorker`
- [ ] `platy app sync` when the gateway must know new methods/scopes
- [ ] `npm run check`, `go vet jsmunro.me/platy/sdk/...`, relevant worker tests
