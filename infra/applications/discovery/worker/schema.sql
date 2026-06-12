CREATE TABLE IF NOT EXISTS discovery_applications (
  name TEXT PRIMARY KEY,
  audience TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  trust_zone TEXT NOT NULL DEFAULT '',
  trust_boundary TEXT NOT NULL DEFAULT '{}',
  access TEXT NOT NULL DEFAULT '{}',
  impersonation_access_client_id TEXT NOT NULL DEFAULT '',
  provider_oauth_client_id TEXT NOT NULL DEFAULT '',
  provider_oauth_scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS discovery_resources (
  application TEXT NOT NULL REFERENCES discovery_applications(name) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (application, name)
);

CREATE TABLE IF NOT EXISTS discovery_methods (
  application TEXT NOT NULL,
  resource TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (application, resource, name)
);

CREATE TABLE IF NOT EXISTS discovery_delegations (
  application TEXT NOT NULL,
  audience TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (application, audience)
);

CREATE TABLE IF NOT EXISTS discovery_gateway (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issuer TEXT NOT NULL DEFAULT '',
  jwks_uri TEXT NOT NULL DEFAULT '',
  endpoints TEXT NOT NULL DEFAULT '{}',
  oidc TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS discovery_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  synced_at INTEGER NOT NULL DEFAULT 0,
  applications INTEGER NOT NULL DEFAULT 0,
  delegations INTEGER NOT NULL DEFAULT 0,
  methods INTEGER NOT NULL DEFAULT 0
);
