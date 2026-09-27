-- One complete, versioned configuration; conditional updates prevent lost edits.
CREATE TABLE ai_runtime_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision TEXT NOT NULL,
    document TEXT NOT NULL CHECK (json_valid(document))
);
