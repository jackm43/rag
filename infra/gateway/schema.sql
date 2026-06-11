CREATE TABLE IF NOT EXISTS idp_applications (
  name TEXT PRIMARY KEY,
  audience TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  resources TEXT NOT NULL DEFAULT '[]',
  provider TEXT NOT NULL DEFAULT '',
  trust_boundary TEXT NOT NULL DEFAULT '{}',
  access TEXT NOT NULL DEFAULT '{}',
  impersonation_access_client_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS idp_provider_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS idp_service_clients (
  client_id TEXT PRIMARY KEY,
  application TEXT NOT NULL REFERENCES idp_applications(name) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS idp_sessions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  email TEXT,
  jkt TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_refresh_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS idp_delegations (
  application TEXT NOT NULL REFERENCES idp_applications(name) ON DELETE CASCADE,
  audience TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (application, audience)
);

CREATE TABLE IF NOT EXISTS idp_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO idp_applications (name, audience, endpoint, description, resources)
VALUES (
  'idp',
  'idp',
  '',
  'Authentication gateway: identity, token exchange, registry, discovery',
  '[{"name":"IdentityService","methods":[{"name":"WhoAmI","scope":"idp/IdentityService.WhoAmI"},{"name":"ExchangeToken","scope":"idp/IdentityService.ExchangeToken"}]},{"name":"RegistryService","methods":[{"name":"RegisterApplication","scope":"idp/RegistryService.RegisterApplication"},{"name":"GetApplication","scope":"idp/RegistryService.GetApplication"},{"name":"ListApplications","scope":"idp/RegistryService.ListApplications"},{"name":"DeleteApplication","scope":"idp/RegistryService.DeleteApplication"},{"name":"RegisterClient","scope":"idp/RegistryService.RegisterClient"}]},{"name":"DiscoveryService","methods":[{"name":"Discover","scope":"idp/DiscoveryService.Discover"}]}]'
);
