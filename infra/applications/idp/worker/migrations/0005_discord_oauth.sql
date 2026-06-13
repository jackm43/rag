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
