-- Retain existing interaction history; correlate each new call with its settings and trigger.
ALTER TABLE rag_ai_interactions ADD COLUMN settings_revision TEXT;
ALTER TABLE rag_ai_interactions ADD COLUMN trigger_kind TEXT;

-- Equality on kind and a range on id allow history to seek rather than scan other request kinds.
CREATE INDEX idx_rag_ai_interactions_kind_id ON rag_ai_interactions(kind, id);
CREATE INDEX idx_rag_ai_interactions_message ON rag_ai_interactions(message_id);
-- Match the leaderboard's count ordering and deterministic tie break, stopping at ten users.
CREATE INDEX idx_rag_totals_leaderboard ON rag_totals(rag_count DESC, ragged_user_id ASC);
