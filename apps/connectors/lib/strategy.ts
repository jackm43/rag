import { apiKeyProvider } from "./providers/api-key";
import { githubProvider } from "./providers/github";
import { oauth2Provider } from "./providers/oauth2";
import {
  ConnectorError,
  type ConnectorKind,
  type ConnectorProvider,
  type ConnectorStrategy,
} from "./types";

// The registered providers. A provider is ONE cohesive file
// (providers/<name>.ts) implementing all of that provider's supported flows;
// adding a provider is a file there plus an entry here. The strategy table below
// is DERIVED from what each provider declares it supports — a provider that fits
// an existing authentication shape (kind) needs no change here at all, only a
// registry config entry (registry.ts).
export const PROVIDERS: readonly ConnectorProvider[] = [apiKeyProvider, githubProvider, oauth2Provider];

// kind -> strategy, built by unfolding each provider's declared strategies.
const STRATEGIES: ReadonlyMap<ConnectorKind, ConnectorStrategy> = (() => {
  const table = new Map<ConnectorKind, ConnectorStrategy>();
  for (const provider of PROVIDERS) {
    for (const strategy of provider.strategies) {
      table.set(strategy.kind, strategy);
    }
  }
  return table;
})();

export const strategyFor = (kind: ConnectorKind): ConnectorStrategy => {
  const strategy = STRATEGIES.get(kind);
  if (!strategy) {
    throw new ConnectorError(500, `no_strategy_for_kind:${kind}`);
  }
  return strategy;
};
