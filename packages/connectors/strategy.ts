import { apiKeyStrategy } from "./strategies/api-key";
import { githubAppStrategy } from "./strategies/github-app";
import { oauth2AuthorizationCodeStrategy } from "./strategies/oauth2-authorization-code";
import { oauth2ClientCredentialsStrategy } from "./strategies/oauth2-client-credentials";
import { ConnectorError, type ConnectorKind, type ConnectorStrategy } from "./types";

// The strategy table, keyed by kind. Adding a genuinely new authentication shape
// is a new entry here; adding a provider that fits an existing shape is only a
// registry config entry (see registry.ts) — no code.
const STRATEGIES: Record<ConnectorKind, ConnectorStrategy> = {
  api_key: apiKeyStrategy,
  oauth2_client_credentials: oauth2ClientCredentialsStrategy,
  oauth2_authorization_code: oauth2AuthorizationCodeStrategy,
  github_app: githubAppStrategy,
};

export const strategyFor = (kind: ConnectorKind): ConnectorStrategy => {
  const strategy = STRATEGIES[kind];
  if (!strategy) {
    throw new ConnectorError(500, `no_strategy_for_kind:${kind}`);
  }
  return strategy;
};
