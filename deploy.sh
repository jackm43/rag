#!/usr/bin/env bash
set -euo pipefail

op run --env-file=.env -- npm run deploy
op run --env-file=.env -- npm run d1:migrate:remote
op run --env-file=.env -- npm run register:commands
op run --env-file=.env -- sh -c 'curl -X POST "https://ragbot.jsmunro.me/gateway/start" -H "Authorization: Bearer $DISCORD_BOT_TOKEN"'
