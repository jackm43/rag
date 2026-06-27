# Running With 1Password

## Required Secrets

This project expects these environment variables:
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`

`.env` is set to 1Password references (`op://...`), so run project commands through `op run`.

## Current Runtime Shape

- Cloudflare Worker entrypoint: `src/index.ts` (routing only)
- Modules:
  - `src/http.ts` Discord signature verification, JSON responses, constant-time compare
  - `src/discord.ts` Discord REST helpers
  - `src/gateway.ts` `DiscordGateway` Durable Object (`DISCORD_GATEWAY` binding)
  - `src/mention.ts` mention handling, thread tracking, AI title generation, and AI queue consumer (thread conversation context)
  - `src/commands/ask.ts` `/ask` thread creation, normal AI response handling, and web-search research mode
  - `src/ai.ts` model-agnostic chat calls through the Workers AI binding (`env.AI.run`) or AI Gateway REST. Workers AI `@cf/...` models use binding options (`gateway: { id }`), Unified Billing partner chat models use AI Gateway compat chat completions, and `/ask` research mode uses an OpenAI search model such as `openai/gpt-4o-search-preview` via AI Gateway.
  - `src/config.ts` loads source-controlled AI config from `src/ai-config`
  - `src/logger.ts` structured logging
- Discord interactions route: `POST /discord`
- Gateway control routes: `POST /gateway/start`, `GET /gateway/health` (both require `Authorization: Bearer $DISCORD_BOT_TOKEN`)
- Public routes are allowlisted. Any path not listed here returns `404`.
- Database: D1 (`DB` binding) using `schema.sql`
- AI model binding: `AI`
- Queue bindings:
 - producer: `AI_JOBS` -> `ai-jobs`
 - consumer: `ai-jobs` with dead-letter queue `ai-jobs-dlq`

## Runtime Configuration

AI config lives in `src/ai-config`:
- `discord-response.json`: mention and `/ask` response model, max tokens, temperature, thread history limit, AI Gateway id used by the AI binding
- `discord-response-system-prompt.md`: mention response system prompt
- `ask-web-search.json`: `/ask` web-search model, max output tokens, temperature, search turns, search context size, AI Gateway id used by the AI binding
- `ask-web-search-system-prompt.md`: neutral `/ask` web research system prompt

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

Typecheck and test:

```bash
npm run check
npm test
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
- `Create Public Threads`
- `Send Messages in Threads`
- `Use Slash Commands`
- `Read Message History` (required for thread conversation context)

Use the deployed Worker URL plus `/discord` as the Discord interactions endpoint.
