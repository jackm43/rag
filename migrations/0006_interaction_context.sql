-- Usage analytics AI Gateway cannot see: how a request reached Ragbot and how much reply-chain
-- context it carried. Existing rows keep null.
ALTER TABLE rag_ai_interactions ADD COLUMN triggered_by TEXT; -- mention, reply, command or tool
ALTER TABLE rag_ai_interactions ADD COLUMN context_messages INTEGER;
