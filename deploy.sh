#!/usr/bin/env bash
set -euo pipefail

op run --env-file=.env -- npm run deploy
op run --env-file=.env -- sh -c 'curl -X POST "https://ragbot-worker.jsmunro.workers.dev/gateway/start" -H "Authorization: Bearer $DISCORD_BOT_TOKEN"'
