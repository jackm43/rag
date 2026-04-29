# Running With 1Password

## Required Secrets

This project expects these environment variables:
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`
- `CLIENT_ID`
- `CLIENT_SECRET`

`.env` is set to 1Password references (`op://...`), so run project commands through `op run`.

## Current Runtime Shape

- Cloudflare Worker entrypoint: `src/index.ts`
- Discord interactions route: `POST /`
- Gateway control routes: `POST /gateway/start`, `GET /gateway/health`
- Durable Object: `DiscordGateway` (`DISCORD_GATEWAY` binding)
- Database: D1 (`DB` binding) using `schema.sql`
- AI model binding: `AI`
- Queue bindings:
  - producer: `AI_JOBS` -> `ai-jobs`
  - consumer: `ai-jobs` with dead-letter queue `ai-jobs-dlq`

## Setup and Run Commands

Install dependencies:

```bash
op run --env-file=.env -- npm install
```

Create D1 database:

```bash
op run --env-file=.env -- npx wrangler d1 create ragbot
```

Copy generated IDs into `wrangler.jsonc`:
- `database_id`
- `preview_database_id`

Apply D1 schema locally:

```bash
op run --env-file=.env -- npm run d1:migrate:local
```

Create queues:

```bash
op run --env-file=.env -- npx wrangler queues create ai-jobs
op run --env-file=.env -- npx wrangler queues create ai-jobs-dlq
```

Register slash commands:

```bash
op run --env-file=.env -- npm run register:commands
```

Run local Worker dev server:

```bash
op run --env-file=.env -- npm run dev
```

Deploy Worker:

```bash
op run --env-file=.env -- npm run deploy
```

Start Gateway connection (after deploy):

```bash
op run --env-file=.env -- sh -c 'curl -X POST "https://ragbot-worker.jsmunro.workers.dev/gateway/start" -H "Authorization: Bearer $DISCORD_BOT_TOKEN"'
```

Or run the helper:

```bash
./deploy.sh
```

## Discord App Configuration

Bot scopes:
- `bot`
- `applications.commands`

Bot permissions:
- `Send Messages`
- `Use Slash Commands`

Use the deployed Worker URL as the Discord interactions endpoint.
