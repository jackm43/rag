-- App builds requested from Discord. The builder service owns build state;
-- this table records intake, the workspace thread and the last status seen.
CREATE TABLE build_requests (
    id TEXT PRIMARY KEY,
    -- The Discord message or interaction that asked; makes intake idempotent.
    source_id TEXT NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    requester_user_id TEXT NOT NULL,
    prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 6000),
    status TEXT NOT NULL DEFAULT 'submitted',
    revision INTEGER NOT NULL DEFAULT 1,
    url TEXT,
    thread_id TEXT,
    -- Claimed before the Discord POST so an ambiguous failure is never retried.
    thread_attempted INTEGER NOT NULL DEFAULT 0,
    announced_revision INTEGER NOT NULL DEFAULT 0,
    last_polled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX build_requests_pending ON build_requests (announced_revision, revision, last_polled);
CREATE UNIQUE INDEX build_requests_thread ON build_requests (thread_id) WHERE thread_id IS NOT NULL;
