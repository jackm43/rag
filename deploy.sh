#!/usr/bin/env bash
set -euo pipefail

# Deploys the core four workers (responder, gateway, workflows, spend). The
# registry, connectors broker, dev-proxy, and webhooks workers are deployed
# individually per their DEPLOY.md / CONNECTORS.md checklists (they have
# one-time bootstrap steps — queues, bindings, Access apps — and strict
# ordering: the broker must exist before the webhooks worker binds it).
#   npm run deploy:webhooks   # after `wrangler queues create webhook-jobs{,-dlq}`
op run --env-file=.env -- npm run deploy
op run --env-file=.env -- npm run config:push
op run --env-file=.env -- npm run d1:migrate:remote
op run --env-file=.env -- npm run register:commands
op run --env-file=.env -- sh -c 'curl -X POST "https://ragbot.jsmunro.me/gateway/start" -H "Authorization: Bearer $GATEWAY_CONTROL_TOKEN"'
