import type { Env } from "../contracts/types";
import type { MachinePrincipal } from "../auth/principal";
import type { BoundaryFetch } from "../boundaries/outbound/boundary-client";
import type { SecretRef } from "../secrets";
import type { AccessTokenCache } from "./cache";
import type { GrantStore, OAuthStateStore, OAuthTokenStore } from "./store";
import type { WebhookProvider } from "./webhooks";

// The connector abstraction. A connector is a declarative config entry keyed by
// `kind`; adding a provider is a config entry plus — only for a genuinely new
// authentication shape — a new strategy. Everything else (the authn+authz gate,
// the phantom-token grant/use flow, audit logging, egress) is uniform.

export type ConnectorKind =
  | "api_key"
  | "oauth2_client_credentials"
  | "oauth2_authorization_code"
  | "github_app";

export type ConnectorConfig = {
  // Stable slug (CONNECTOR_ID_PATTERN). Also the default Cedar resource id.
  id: string;
  kind: ConnectorKind;
  // The single provider host this connector may reach. The broker builds one
  // outbound boundary client per connector, host-allowlisted to exactly this.
  host: string;
  // Cedar resource id: authorization is against `Connector::<cedarResource>`.
  // Defaults to `id`; a shared resource lets several connectors reuse one grant.
  cedarResource: string;
  // A {provider, ref} reference to this connector's secret material: the API key
  // (api_key), the OAuth client secret (oauth2_*), or the App private-key PEM
  // (github_app). The strategy resolves it through the secrets-provider module
  // (packages/secrets) — secretsProvider(env, ref.provider).get(ref.ref) — so the
  // credential can live in a worker secret (wrangler-env), Cloudflare Secrets
  // Store, HashiCorp Vault, or 1Password without a code change. Resolution fails
  // closed: an unresolved reference denies the connector op.
  secret: SecretRef;
  // api_key: which header to inject and an optional scheme prefix.
  //   { header: "authorization", scheme: "Bearer" } -> "Authorization: Bearer <key>"
  //   { header: "x-api-key" }                        -> "x-api-key: <key>"
  headerTemplate?: { header: string; scheme?: string };
  // oauth2_client_credentials / oauth2_authorization_code: the token endpoint.
  tokenUrl?: string;
  // oauth2_authorization_code (3LO): the authorization endpoint + OAuth client id.
  authorizationUrl?: string;
  clientId?: string;
  // Alternative to a literal `clientId`: a {provider, ref} the client id is
  // resolved through (mirrors `appId`), so an operator can provision it as a
  // worker secret / remote-backend entry instead of committing it. A literal
  // `clientId` wins when both are set.
  clientIdRef?: SecretRef;
  // oauth2_authorization_code (3LO): the exact redirect_uri sent on both begin
  // (the consent URL) and complete (the code exchange). The convention is the
  // admin app's callback, https://ragbot-dev.jsmunro.me/api/connectors/{id}/callback
  // (CONNECTORS.md "URL conventions"). Config is authoritative; when absent the
  // strategy falls back to a caller-supplied `redirectUri` param.
  redirectUri?: string;
  // Inbound webhook verification for this connector: which provider signature
  // scheme applies, the {provider, ref} of the webhook signing secret, and an
  // enabled flag (a kill switch that fails verification closed). The URL-path
  // provider segment on the webhooks worker is routing sugar only — THIS config
  // is authoritative, and a mismatch denies (handler.ts webhook_verify).
  webhook?: { provider: WebhookProvider; secret: SecretRef; enabled: boolean };
  // github_app: a {provider, ref} reference to the numeric App id (the JWT
  // `iss`). Defaults to {provider:"wrangler-env", ref:"GITHUB_APP_ID"}.
  appId?: SecretRef;
  // Default scopes for a grant that does not name any (client_credentials / 3LO).
  defaultScopes?: string[];
  // Headers always added to an authorizedFetch (e.g. GitHub's Accept).
  staticHeaders?: Record<string, string>;
  // Per-connector egress limits for the boundary client.
  timeoutMs?: number;
  maxResponseBytes?: number;
  // How long an issued handle stays usable, in seconds. Capped to the resolved
  // credential's own lifetime when that is shorter. Defaults to 300s.
  grantTtlSeconds?: number;
};

// Header name -> value, injected into an authorizedFetch alongside the caller's
// request headers. This is where the real credential enters the request — and it
// never leaves the broker.
export type CredentialInjection = Record<string, string>;

// A real, short-lived provider token. Returned to a caller ONLY via the
// connector.token escape hatch; the preferred fetch path keeps it broker-side.
export type ResolvedToken = {
  value: string;
  tokenType: string;
  // Epoch seconds; absent when the provider does not state an expiry.
  expiresAt?: number;
};

export type ConnectorAuthorizationBegin = {
  url: string;
  state: string;
};

// Everything a strategy needs to resolve a credential, with no ambient access:
// the connector config, the env (for secrets), the host-allowlisted boundary
// fetch, the per-isolate token cache, the persistent 3LO token store, and the
// grant's subject/scopes/params.
export type StrategyContext = {
  connector: ConnectorConfig;
  env: Env;
  fetch: BoundaryFetch;
  now: () => number;
  tokenCache: AccessTokenCache;
  oauthTokens: OAuthTokenStore;
  // Pending 3LO authorization states (persisted at begin, consumed once at
  // complete), so a completion with an unknown/foreign/replayed state fails.
  oauthStates: OAuthStateStore;
  subject: string;
  scopes: string[];
  // Connector-specific parameters, validated by the strategy (e.g. github_app's
  // installationId). Captured at grant time and replayed on use.
  params: Record<string, unknown>;
};

// A strategy implements one `kind`. `prepare` runs at grant time (validate +
// warm caches, never returning a secret); `inject`/`token` run at use time.
// 3LO connectors additionally implement begin/complete. A strategy that does not
// support an operation omits the method (or throws), and the broker fails closed.
export type ConnectorStrategy = {
  kind: ConnectorKind;
  prepare: (ctx: StrategyContext) => Promise<{ expiresAt: number }>;
  inject: (ctx: StrategyContext) => Promise<CredentialInjection>;
  token: (ctx: StrategyContext) => Promise<ResolvedToken>;
  beginAuthorization?: (ctx: StrategyContext) => Promise<ConnectorAuthorizationBegin>;
  completeAuthorization?: (ctx: StrategyContext) => Promise<void>;
};

// A provider is ONE cohesive file (providers/<name>.ts) implementing ALL of a
// provider's supported flows behind the strategy interface. It declares which
// `kinds` it supports and contributes one strategy per kind; the strategy table
// (strategy.ts) is derived from what the registered providers declare. Providers
// resolve credentials and talk to their provider host ONLY — they never touch
// the identity token, Cedar, or the grant store (that is the broker infra).
export type ConnectorProvider = {
  // The provider name, matching the file (e.g. "github", "oauth2", "api-key").
  name: string;
  // Every kind this provider implements; must equal the kinds of `strategies`.
  kinds: readonly ConnectorKind[];
  strategies: readonly ConnectorStrategy[];
};

// A grant entry: the actor context captured at grant time plus a reference to
// re-resolve the real credential on use. It holds NO secret — the credential is
// re-resolved from the connector's secret binding / token store each use.
export type GrantEntry = {
  handle: string;
  connectorId: string;
  // The verified machine principal the handle was issued to. A handle presented
  // by any other caller is rejected — this is the phantom-token binding.
  callerPrincipal: MachinePrincipal;
  subject: string;
  scopes: string[];
  params: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
};

// A coarse, fail-closed error the handler maps to a bare ConnectorResult status.
export class ConnectorError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string) {
    super(reason);
    this.name = "ConnectorError";
    this.status = status;
    this.reason = reason;
  }
}

export type { GrantStore, OAuthStateStore, OAuthTokenStore, StoredOAuthToken } from "./store";
export type { AccessTokenCache } from "./cache";
