import type { CedarValueJson, EntityJson } from "@cedar-policy/cedar-wasm/web";
import type { MachinePrincipal } from "@rag/service-kit/principal";
import type { ConnectorCapability, ConnectorConfig } from "./types";

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
    capabilities: {
      grant: ["workflows", "dev-proxy", "registry", "attest"],
      fetch: ["workflows", "dev-proxy", "registry", "attest"],
      token: ["workflows"],
      webhookVerify: ["webhooks", "attest"],
      adminRead: ["dev-proxy"],
      adminWrite: ["dev-proxy"],
    },
    // The App private-key PEM. Defaults to the worker secret GITHUB_APP_PRIVATE_KEY
    // (wrangler-env) so behaviour is unchanged; point `provider` at another
    // backend (cloudflare-secret-store / hashicorp-vault / onepassword) to move
    // it. The numeric App id is read via the default appId ref (GITHUB_APP_ID).
    secret: { provider: "wrangler-env", ref: "GITHUB_APP_PRIVATE_KEY" },
    appId: { provider: "wrangler-env", ref: "GITHUB_APP_ID" },
    staticHeaders: {
      accept: "application/vnd.github+json",
      "user-agent": "rag-apps-gateway",
    },
    // Installation tokens last ~1h; align the handle lifetime to that.
    grantTtlSeconds: 3600,
    maxResponseBytes: 5 * 1024 * 1024,
    // Inbound webhook verification: the App's webhook deliveries land on the
    // webhooks worker (webhooks.jsmunro.me/github/github-app) and are verified
    // via webhook_verify with GitHub's HMAC-SHA256 scheme. This config — not the
    // URL path — decides the scheme, and the secret stays broker-side.
    webhook: {
      provider: "github",
      secret: { provider: "wrangler-env", ref: "GITHUB_WEBHOOK_SECRET" },
      enabled: true,
    },
  },

  // The Discord 3LO connector: end users authorize via the consent redirect
  // (begin/complete), and the broker stores their tokens per subject. The
  // consent ceremony is driven by the admin app's callback endpoint — the
  // redirect_uri below, per the connectors URL convention — while the tokens
  // themselves never leave the broker. The client id is not a secret but is
  // deployment-specific, so it is resolved via a wrangler-env ref (mirroring
  // github-app's appId) rather than committed as a literal.
  {
    id: "discord-user",
    kind: "oauth2_authorization_code",
    host: "discord.com",
    cedarResource: "discord-user",
    capabilities: {
      authorize: ["dev-proxy"],
      adminRead: ["dev-proxy"],
      adminWrite: ["dev-proxy"],
    },
    tokenUrl: "https://discord.com/api/oauth2/token",
    authorizationUrl: "https://discord.com/oauth2/authorize",
    clientIdRef: { provider: "wrangler-env", ref: "DISCORD_OAUTH_CLIENT_ID" },
    secret: { provider: "wrangler-env", ref: "DISCORD_OAUTH_CLIENT_SECRET" },
    redirectUri: "https://ragbot-dev.jsmunro.me/api/connectors/discord-user/callback",
    defaultScopes: ["identify"],
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

const capabilityAttr: Record<ConnectorCapability, string> = {
  grant: "grant",
  fetch: "fetch",
  token: "token",
  authorize: "authorize",
  webhookVerify: "webhookVerify",
  adminRead: "adminRead",
  adminWrite: "adminWrite",
};

const appRefs = (apps: MachinePrincipal[] | undefined) =>
  (apps ?? []).map((app) => ({ __entity: { type: "Application", id: app } }));

const hasManagementCapability = (capabilities: Partial<Record<ConnectorCapability, Set<MachinePrincipal>>>) =>
  (capabilities.adminRead?.size ?? 0) > 0 || (capabilities.adminWrite?.size ?? 0) > 0;

export const connectorsToEntities = (connectors: ConnectorConfig[] = CONNECTOR_REGISTRY): EntityJson[] => {
  const byResource = new Map<string, ConnectorConfig[]>();
  for (const connector of connectors) {
    const existing = byResource.get(connector.cedarResource) ?? [];
    existing.push(connector);
    byResource.set(connector.cedarResource, existing);
  }

  const entities: EntityJson[] = [
    {
      uid: { type: "Connector", id: "*" },
      attrs: {
        plane: "management",
        adminList: appRefs(["dev-proxy"]),
      },
      parents: [],
    },
  ];

  for (const [resource, grouped] of byResource) {
    const merged: Partial<Record<ConnectorCapability, Set<MachinePrincipal>>> = {};
    for (const connector of grouped) {
      for (const [capability, callers] of Object.entries(connector.capabilities ?? {}) as Array<[
        ConnectorCapability,
        MachinePrincipal[],
      ]>) {
        const set = merged[capability] ?? new Set<MachinePrincipal>();
        callers.forEach((caller) => set.add(caller));
        merged[capability] = set;
      }
    }
    const attrs: Record<string, CedarValueJson> = { plane: "data" };
    if (hasManagementCapability(merged)) {
      attrs.planes = ["data", "management"];
    }
    for (const [capability, callers] of Object.entries(merged) as Array<[
      ConnectorCapability,
      Set<MachinePrincipal>,
    ]>) {
      attrs[capabilityAttr[capability]] = appRefs([...callers]);
    }
    entities.push({ uid: { type: "Connector", id: resource }, attrs, parents: [] });
  }

  return entities;
};
