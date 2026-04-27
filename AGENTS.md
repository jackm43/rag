# Running With 1Password

## Required Secrets

This project expects these environment variables:
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`
- `CLIENT_ID`
- `CLIENT_SECRET`

`.env` is already set to 1Password secret references (`op://...`).

## Commands

Install dependencies:

```bash
GITHUB_STAR_TOKEN= op run --env-file=.env -- npm install
```

Create D1 database:

```bash
GITHUB_STAR_TOKEN= op run --env-file=.env -- npx wrangler d1 create ragbot
```

Copy the returned `database_id` values into `wrangler.jsonc` for:
- `database_id`
- `preview_database_id`

Register slash commands:

```bash
GITHUB_STAR_TOKEN= op run --env-file=.env -- npm run register:commands
```

Run local Worker dev server:

```bash
GITHUB_STAR_TOKEN= op run --env-file=.env -- npm run dev
```

Apply D1 schema locally:

```bash
GITHUB_STAR_TOKEN= op run --env-file=.env -- npm run d1:migrate:local
```

Create queues:

```bash
GITHUB_STAR_TOKEN= op run --env-file=.env -- npx wrangler queues create ai-jobs
GITHUB_STAR_TOKEN= op run --env-file=.env -- npx wrangler queues create ai-jobs-dlq
```

Deploy:

```bash
GITHUB_STAR_TOKEN= op run --env-file=.env -- npm run deploy
```

## Discord App Configuration

Bot scopes:
- `bot`
- `applications.commands`

Bot permissions:
- `Send Messages`
- `Use Slash Commands`

Use your deployed Worker URL as the Discord interactions endpoint.
