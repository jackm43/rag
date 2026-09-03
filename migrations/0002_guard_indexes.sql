-- Indexes for the hot read paths that previously full-scanned:
--   * the daily budget guard sums rag_ai_spend_events by created_at on every
--     AI request;
--   * /undorag looks up the latest rag_events row per ragged user;
--   * the cron prunes rag_ai_requests by created_at.
CREATE INDEX IF NOT EXISTS idx_rag_ai_spend_events_created ON rag_ai_spend_events(created_at);
CREATE INDEX IF NOT EXISTS idx_rag_events_ragged ON rag_events(ragged_user_id, id);
CREATE INDEX IF NOT EXISTS idx_rag_ai_requests_created ON rag_ai_requests(created_at);
