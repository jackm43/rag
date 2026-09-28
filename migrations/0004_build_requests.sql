-- Intake only. Execution and deployment require a later migration/integration.
CREATE TABLE build_requests (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    requester_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('site', 'feature')),
    prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 6000),
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX build_requests_guild ON build_requests (guild_id, created_at);
