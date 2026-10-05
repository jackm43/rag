-- Settings become one typed document: `chat` (with its prompt) and `image` objects instead of
-- JSON text keyed by seed file names. Missing chat fields get the defaults the bot used, and
-- image profiles keep `parameters`, built from the older camelCase fields when absent.
-- json_patch('{}', ...) drops null members, so unset optional fields are left out.
UPDATE ai_runtime_settings
SET document = json_patch('{}', json_object(
        'schemaVersion', 3,
        'revision', 'typed:' || revision,
        'updatedAt', json_extract(document, '$.updatedAt'),
        'chat', json((
            SELECT json_object(
                'model', trim(json_extract(chat, '$.model')),
                'prompt', json_extract(document, '$.resources."discord-response-system-prompt.md"'),
                'apiFormat', coalesce(json_extract(chat, '$.apiFormat'), 'chat-completions'),
                'temperature', coalesce(json_extract(chat, '$.temperature'), 0.7),
                'temperatureSupported', json(CASE WHEN coalesce(json_extract(chat, '$.temperatureSupported'), 1) THEN 'true' ELSE 'false' END),
                'historyLimit', min(max(CAST(coalesce(json_extract(chat, '$.historyLimit'), 12) AS INTEGER), 1), 12),
                'reasoningEffort', CASE WHEN json_extract(chat, '$.reasoningEffort') IN ('low', 'medium', 'high', 'xhigh')
                    THEN json_extract(chat, '$.reasoningEffort') END,
                'gatewayId', nullif(trim(json_extract(chat, '$.gatewayId')), ''))
            FROM (SELECT json_extract(document, '$.resources."discord-response.json"') AS chat)
        )),
        'image', json((
            SELECT json_object(
                'activeProfile', json_extract(image, '$.activeProfile'),
                'profiles', json((
                    SELECT json_group_object(p.key, json_object(
                        'model', trim(json_extract(p.value, '$.model')),
                        'gatewayId', nullif(trim(json_extract(p.value, '$.gatewayId')), ''),
                        'parameters', json(coalesce(json_extract(p.value, '$.parameters'), json_object(
                            'response_format', json_extract(p.value, '$.responseFormat'),
                            'aspect_ratio', json_extract(p.value, '$.aspectRatio'),
                            'quality', json_extract(p.value, '$.quality'),
                            'resolution', json_extract(p.value, '$.resolution'))))))
                    FROM json_each(image, '$.profiles') AS p)))
            FROM (SELECT json_extract(document, '$.resources."bicture-image.json"') AS image)
        )))),
    revision = 'typed:' || revision
WHERE id = 1 AND json_extract(document, '$.schemaVersion') = 2;
