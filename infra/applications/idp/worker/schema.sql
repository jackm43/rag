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
  provider_oauth_client_id TEXT NOT NULL DEFAULT '',
  provider_oauth_scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS idp_provider_grants (
  subject TEXT NOT NULL,
  application TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (subject, application)
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
  tier TEXT NOT NULL DEFAULT 'internal',
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
  'https://auth-gateway.jsmunro.me',
  'Authentication gateway: identity, token exchange, registry, discovery',
  '[{"name":"IdentityService","methods":[{"name":"Introspect","scope":"idp/IdentityService.Introspect"}]},{"name":"RegistryService","methods":[{"name":"RegisterApplication","scope":"idp/RegistryService.RegisterApplication"},{"name":"GetApplication","scope":"idp/RegistryService.GetApplication"},{"name":"ListApplications","scope":"idp/RegistryService.ListApplications"},{"name":"DeleteApplication","scope":"idp/RegistryService.DeleteApplication"},{"name":"RegisterClient","scope":"idp/RegistryService.RegisterClient"}]},{"name":"DiscoveryService","methods":[{"name":"Discover","scope":"idp/DiscoveryService.Discover"}]},{"name":"TraceService","methods":[{"name":"ListTraces","scope":"idp/TraceService.ListTraces"},{"name":"GetTrace","scope":"idp/TraceService.GetTrace"},{"name":"StreamTraces","scope":"idp/TraceService.StreamTraces"}]},{"name":"ClientIdentityService","methods":[{"name":"RegisterClientIdentity","scope":"idp/ClientIdentityService.RegisterClientIdentity"},{"name":"ListClientIdentities","scope":"idp/ClientIdentityService.ListClientIdentities"}]}]'
);

CREATE TABLE IF NOT EXISTS idp_spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'internal',
  start_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT NOT NULL DEFAULT '',
  attributes TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_idp_spans_trace ON idp_spans(trace_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_idp_spans_roots ON idp_spans(parent_span_id, start_ms DESC);

CREATE TABLE IF NOT EXISTS idp_client_identities (
  instance_id TEXT PRIMARY KEY,
  application TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  jkt TEXT NOT NULL DEFAULT '',
  public_jwk TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idp_client_identities_app ON idp_client_identities(application, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idp_spans_created ON idp_spans(created_at);

CREATE TABLE IF NOT EXISTS idp_discord_pending (
  state TEXT PRIMARY KEY,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idp_oauth_codes (
  code TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
