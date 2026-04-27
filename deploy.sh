#!/usr/bin/env bash
set -euo pipefail

GITHUB_STAR_TOKEN= op run --env-file=.env -- npm run deploy
GITHUB_STAR_TOKEN= op run --env-file=.env -- sh -c 'curl -X POST "https://ragbot-worker.jsmunro.workers.dev/gateway/start" -H "Authorization: Bearer $DISCORD_BOT_TOKEN"'
