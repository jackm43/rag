// The credential broker abstraction: the connector strategies, the declarative
// registry, the grant/token stores, and the fail-closed invoke handler that runs
// the authn+authz gate. The connectors worker's entrypoint is a thin shell over
// handleConnectorInvoke; callers use connectorsClient. See CONNECTORS.md.
export { handleConnectorInvoke } from "./handler";
export { connectorsClient } from "./client";
export { CONNECTOR_REGISTRY, lookupConnector } from "./registry";
export { strategyFor, PROVIDERS } from "./strategy";
export { importAppPrivateKey, mintAppJwt, APP_JWT_TTL_SECONDS } from "./providers/github";
export {
  createConnectorConfigStore,
  createGrantStore,
  createOAuthTokenStore,
  createInMemoryKeyValueStore,
  durableObjectKeyValueStore,
  generateHandle,
  type ConnectorConfigStore,
  type GrantStore,
  type KeyValueStore,
  type OAuthTokenStore,
  type StoredOAuthToken,
} from "./store";
export { createAccessTokenCache, sharedAccessTokenCache, type AccessTokenCache } from "./cache";
export {
  ConnectorError,
  type ConnectorConfig,
  type ConnectorKind,
  type ConnectorProvider,
  type ConnectorStrategy,
  type GrantEntry,
  type StrategyContext,
} from "./types";
