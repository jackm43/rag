-- Keep saved prompts and generation settings while removing retired resources.
-- Models use the account catalog IDs directly; no runtime alias routing is needed.
WITH resources AS (
    SELECT json_each.key, json_each.value
    FROM ai_runtime_settings, json_each(document, '$.resources')
    WHERE ai_runtime_settings.id = 1 AND json_extract(document, '$.schemaVersion') = 1
      AND json_each.key IN ('discord-response.json', 'discord-response-system-prompt.md', 'bicture-image.json')
), models AS (
    SELECT key, json_remove(value, '$.maxTokens') AS settings,
           json_extract(value, '$.model') AS model
    FROM resources WHERE key = 'discord-response.json'
    UNION ALL
    SELECT 'profile:' || p.key, p.value, json_extract(p.value, '$.model')
    FROM resources, json_each(resources.value, '$.profiles') AS p
    WHERE resources.key = 'bicture-image.json'
), normalized AS (
    SELECT key, json_set(settings, '$.model', CASE
        WHEN model LIKE 'grok/%' THEN 'xai/' || substr(model, 6)
        WHEN model LIKE 'google-ai-studio/%' THEN 'google/' || substr(model, 18)
        WHEN model LIKE 'workers-ai/%' THEN substr(model, 12)
        ELSE model END) AS settings
    FROM models
), cleaned AS (
    SELECT resources.key, CASE resources.key
        WHEN 'discord-response.json' THEN (SELECT settings FROM normalized WHERE key = resources.key)
        WHEN 'bicture-image.json' THEN json_set(resources.value, '$.profiles', json((
            SELECT json_group_object(substr(key, 9), json(settings))
            FROM normalized WHERE key LIKE 'profile:%'
        )))
        ELSE resources.value END AS value
    FROM resources
)
UPDATE ai_runtime_settings
SET document = json_set(document,
        '$.schemaVersion', 2,
        '$.revision', 'chat-image:' || revision,
        '$.resources', json((SELECT json_group_object(key, value) FROM cleaned))),
    revision = 'chat-image:' || revision
WHERE id = 1 AND json_extract(document, '$.schemaVersion') = 1;
