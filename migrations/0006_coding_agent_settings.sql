-- Extend existing complete D1 settings atomically; keep every prior setting.
UPDATE ai_runtime_settings
SET document = json_set(document, '$.resources."coding-agent.json"', '{
  "model": "gpt-6-sol",
  "siteInstructions": "Build a complete responsive browser application in public/. Use only local text HTML/CSS/JS/SVG assets, no external dependencies at runtime. Authentication is supplied by the host; do not implement login. Shared state: GET /_room/NAME returns {version,data}; PUT with JSON {version,data} atomically updates (409 on conflict). Word games: GET /_wordle/NAME returns {version,guesses,won,over}; POST {version,guess} submits; POST {version,reset:true} resets completed rounds. Poll every 2 seconds; handle 409 by refreshing. The server keeps the answer secret. Keep or improve the node tests; run node --test. Deliver working public/index.html. Do not include secrets.",
  "featureInstructions": "Implement this change in the supplied Ragbot repository. Preserve existing behavior and security. Do not edit deployment, authentication, CI policy, AGENTS.md, builder infrastructure or migrations. Add meaningful tests. Run pnpm run check, pnpm test, pnpm run test:runtime. Never include secrets."
}
', '$.revision', 'builder-v1-' || revision),
    revision = 'builder-v1-' || revision
WHERE json_type(document, '$.resources."coding-agent.json"') IS NULL;
