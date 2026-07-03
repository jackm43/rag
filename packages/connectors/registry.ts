import type { ConnectorConfig } from "./types";

// The declarative connector registry. Each entry is a connector; adding a
// provider is an entry here (plus a new provider file in providers/ ONLY for a
// genuinely new authentication shape). This is the extensibility surface — keep
// entries pure config, with no secret material: each entry names its secret via
// a {provider, ref} reference resolved through the secrets-provider module
// (packages/secrets), never an inline value.
//
// Every field's meaning is documented on ConnectorConfig. The reference
// connector is `github-app` (github_app kind); the commented examples show how
// an api_key and an oauth2_client_credentials connector are added.
export const CONNECTOR_REGISTRY: ConnectorConfig[] = [
  {
    id: "github-app",
    kind: "github_app",
    host: "api.github.com",
    cedarResource: "github-app",
    // The App private-key PEM. Defaults to the worker secret GITHUB_APP_PRIVATE_KEY
    // (wrangler-env) so behaviour is unchanged; point `provider` at another
    // backend (cloudflare-secret-store / hashicorp-vault / onepassword) to move
    // it. The numeric App id is read via the default appId ref (GITHUB_APP_ID).
    secret: { provider: "wrangler-env", ref: "GITHUB_APP_PRIVATE_KEY" },
    appId: { provider: "wrangler-env", ref: "GITHUB_APP_ID" },
    staticHeaders: { accept: "application/vnd.github+json" },
    // Installation tokens last ~1h; align the handle lifetime to that.
    grantTtlSeconds: 3600,
    maxResponseBytes: 5 * 1024 * 1024,
  },

  // Example — an API-key connector (uncomment + provision the secret):
  // {
  //   id: "example-api",
  //   kind: "api_key",
  //   host: "api.example.com",
  //   cedarResource: "example-api",
  //   secret: { provider: "wrangler-env", ref: "EXAMPLE_API_KEY" },
  //   headerTemplate: { header: "authorization", scheme: "Bearer" },
  // },

  // Example — an OAuth2 client-credentials (2LO) connector, secret in Vault:
  // {
  //   id: "example-2lo",
  //   kind: "oauth2_client_credentials",
  //   host: "api.example.com",
  //   cedarResource: "example-2lo",
  //   tokenUrl: "https://auth.example.com/oauth/token",
  //   clientId: "example-client-id",
  //   secret: { provider: "hashicorp-vault", ref: "secret/example#CLIENT_SECRET" },
  //   defaultScopes: ["read"],
  // },
];

const BY_ID = new Map(CONNECTOR_REGISTRY.map((connector) => [connector.id, connector]));

export const lookupConnector = (id: string | undefined): ConnectorConfig | null =>
  id ? BY_ID.get(id) ?? null : null;
