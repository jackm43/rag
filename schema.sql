CREATE TABLE IF NOT EXISTS rag_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ragged_user_id TEXT NOT NULL,
  ragged_username TEXT,
  reported_by_user_id TEXT NOT NULL,
  reported_by_username TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rag_events_reporter ON rag_events(reported_by_user_id);

CREATE TABLE IF NOT EXISTS rag_command_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  banned_user_id TEXT NOT NULL,
  banned_username TEXT,
  banned_by_user_id TEXT NOT NULL,
  banned_by_username TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rag_command_bans_user_expires ON rag_command_bans(banned_user_id, expires_at);

CREATE TABLE IF NOT EXISTS rag_totals (
  ragged_user_id TEXT PRIMARY KEY,
  ragged_username TEXT,
  rag_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS rag_ai_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL UNIQUE,
  parent_channel_id TEXT,
  source_message_id TEXT,
  requester_user_id TEXT,
  requester_username TEXT,
  initial_prompt TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rag_ai_threads_parent ON rag_ai_threads(parent_channel_id);
