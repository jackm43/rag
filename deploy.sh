#!/usr/bin/env bash
set -euo pipefail

# Deploys the core set via `pnpm run deploy` (scripts/deploy.ts discovers the
# wrangler configs under apps/ and deploys in binding-safe order): egress ->
# connectors -> responder -> registry -> attest -> metadata -> gateway ->
# workflows -> spend. The dev-proxy and webhooks workers are deployed
# individually per the README's one-time bootstrap checklist (they have
# one-time bootstrap steps — queues, bindings, Access apps).
#   pnpm run deploy:webhooks   # after `wrangler queues create webhook-jobs{,-dlq}`
#   pnpm run deploy:dev-proxy  # after its Access app + assets bootstrap
op run --env-file=.env -- pnpm run deploy
op run --env-file=.env -- pnpm run config:push
op run --env-file=.env -- pnpm run d1:migrate:remote
op run --env-file=.env -- pnpm run register:commands
op run --env-file=.env -- sh -c 'curl -X POST "https://ragbot.jsmunro.me/gateway/start" -H "Authorization: Bearer $GATEWAY_CONTROL_TOKEN"'
