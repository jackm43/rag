CREATE TABLE IF NOT EXISTS rag_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ragged_user_id TEXT NOT NULL,
  ragged_username TEXT,
  reported_by_user_id TEXT NOT NULL,
  reported_by_username TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rag_events_reporter ON rag_events(reported_by_user_id);

CREATE TABLE IF NOT EXISTS rag_totals (
  ragged_user_id TEXT PRIMARY KEY,
  ragged_username TEXT,
  rag_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rag_roasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roast_text TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS oauth_refresh_tokens;

CREATE TABLE IF NOT EXISTS rag_ai_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  requester_user_id TEXT,
  requester_username TEXT,
  prompt TEXT NOT NULL,
  response_text TEXT,
  model TEXT NOT NULL,
  ai_duration_ms INTEGER,
  total_duration_ms INTEGER,
  status TEXT NOT NULL,
  error_message TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
