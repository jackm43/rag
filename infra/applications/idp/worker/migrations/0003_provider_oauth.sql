ALTER TABLE idp_applications ADD COLUMN provider_oauth_client_id TEXT NOT NULL DEFAULT '';
ALTER TABLE idp_applications ADD COLUMN provider_oauth_scopes TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS idp_provider_grants (
  subject TEXT NOT NULL,
  application TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (subject, application)
);
