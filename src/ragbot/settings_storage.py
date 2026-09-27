"""Shared SQL for the primary-only runtime lookup and atomic editor saves."""

READ_SETTINGS = "SELECT revision, document FROM ai_runtime_settings WHERE id = 1"
WRITE_SETTINGS = """INSERT INTO ai_runtime_settings (id, revision, document) VALUES (1, ?, ?)
ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, document = excluded.document
WHERE ai_runtime_settings.revision = ?"""
