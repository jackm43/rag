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

CREATE TABLE IF NOT EXISTS discord_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  author_user_id TEXT,
  author_username TEXT,
  author_display_name TEXT,
  content TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  mentions_bot INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_discord_messages_channel_observed
  ON discord_messages(channel_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_discord_messages_author_observed
  ON discord_messages(author_user_id, observed_at);

CREATE TABLE IF NOT EXISTS assistant_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  guild_id TEXT,
  channel_id TEXT,
  user_id TEXT,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  source_message_id TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_assistant_memories_scope
  ON assistant_memories(scope, guild_id, channel_id, user_id, updated_at);

CREATE TABLE IF NOT EXISTS assistant_tool_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  requester_user_id TEXT,
  query TEXT,
  result_preview TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_assistant_tool_runs_created
  ON assistant_tool_runs(created_at);

CREATE TABLE IF NOT EXISTS discord_bot_role_cache (
  guild_id TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  role_ids_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, bot_user_id)
);
