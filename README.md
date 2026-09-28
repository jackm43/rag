# ragbot

A Discord bot running as one **Cloudflare Python Worker**, `ragbot-worker`, with
one `DiscordGateway` Durable Object maintaining the Discord WebSocket.
Commands: `/rag`, `/ragboard`, `/raghammer`, `/ragunban`, `/undorag`, `/ask`,
`/bicture`.

`/undorag` and `/raghammer` require the Mods role (`457695154892177418`).
`/ragunban` uses the existing administrator user allowlist.

Discord interaction signatures and gateway control bearer tokens are verified at
the external edges. Denials have empty bodies. Commands, mentions, AI calls, and
ordinary chat replies run in-process. App builds use the separate builder service.

## Discord app builder

Members can say `@ragbot build a three.js galaxy we can fly through` (or use
`/build`) and get a link to a working web app that only members of the server
can open. Ragbot opens a workspace thread for each app; there the owner or Mods
mention Ragbot with changes, and each change becomes a new revision at the same
URL. `/buildstatus`, `/buildedit`, `/buildcancel`, `/buildrollback` and
`/builddelete` manage apps.

The separate `builder/` TypeScript Worker does the work: a coding agent runs in
a Cloudflare Container with inference through AI Gateway (no provider API key),
apps are served from private R2 at `https://apps.jsmunro.me/<app>/` behind
Discord login and guild-membership checks, Durable Objects provide realtime
multiplayer rooms, and an app's optional server rules (hidden answers, private
hands) run sandboxed in Dynamic Workers. See the
[setup and runtime guide](docs/discord-builder-setup.md) and the
[requirements](docs/discord-builder-prd.md). `BUILDER_ENABLED` stays `false`
until setup is done; apply migration 0004 before enabling it.

## Setup

- Node **22+**, pnpm, and **uv 0.12.3+**. Python is installed by uv.
- `op` (1Password CLI) for commands using secrets. `.env` and `.env.dev` contain
  `op://` references; do not replace them with plaintext secrets.
- Docker Desktop on Windows for `pnpm run dev:ui` (Python Workers Pyodide cannot
  create its venv on native Windows).

```sh
pnpm install
uv sync --locked
pnpm run check
pnpm test
pnpm run test:runtime
```

The Python dependencies are locked in `uv.lock`, including a project-local uv
for the Python Workers build tool. Node is used only for Cloudflare
Wrangler. Python Workers use Pyodide. discord.py imports and its aiohttp
networking work here, but its unmodified gateway heartbeat requires unsupported threads;
see the recorded compatibility results in the migration notes.

## Discord library and Python design

[`discord-typings`](https://github.com/Bluenix2/discord-typings/) replaces the
former `discord-api-types` dependency. It supplies Discord wire types without
owning HTTP, WebSocket connections, or an event loop. A small async
`DiscordClient` uses Workers Fetch with per-route/global rate-limit handling
and bounded retries. The existing Durable Object owns the Discord gateway. See [migration notes](docs/python-workers-migration.md) for the
library decision and validation.

Application services use dataclasses, async methods, a decorator-based command
registry, native dictionaries, and explicit dependency injection. SDK bindings
accept Python values directly; raw JavaScript APIs are isolated to Web Crypto,
WebSockets, multipart files, and capped stream reads.

```text
src/entry.py             Worker and DiscordGateway entrypoints
src/ragbot/commands/     registry and moderation/chat/media commands
src/ragbot/app.py        dispatch and mention handling
src/ragbot/gateway.py    gateway lifecycle, heartbeats, deduplication
src/ragbot/discord.py    Discord REST and capped media downloads
src/ragbot/discord_http.py  native rate limits and bounded retries
src/ragbot/ai.py         inference, attribution, shared /ask routing
src/ragbot/ai_config/    editable JSON configs and Markdown prompts
src/ragbot/config.py     per-request D1 configuration snapshots
src/ragbot/db.py         D1 access, bans, threads
src/ragbot/security.py   external authentication
src/js-stubs/            generated Workers API type hints
migrations/             existing D1 schema migrations
scripts/                registration, local launchers, build and checks
tests/                 pytest and actual Workers runtime integration tests
dev/                   local-only Python debugging UI and browser assets
```

## Everyday commands

```sh
pnpm run build                               # regenerate bundled AI config
pnpm run check                               # Ruff, formatting, mypy, config freshness
pnpm test                                    # Python behavior tests with real SQLite schema
pnpm run test:runtime                         # actual local Python Worker, no live services
pnpm run d1:migrate:local
op run --env-file=.env -- pnpm run dev
pnpm run dev:ui                              # op run loads .env + .env.dev automatically
op run --env-file=.env -- pnpm run register:commands
op run --env-file=.env -- pnpm run d1:migrate:remote
op run --env-file=.env -- pnpm run deploy
pnpm run types                              # regenerate src/js-stubs
```

Registration is guild-scoped and reads the same Python registry as dispatch.
`schema.sql` remains a read-only mirror: change the schema through migrations.

## Local debugging UI

`pnpm run dev:ui` serves the existing console on **http://localhost:8788**.
On Windows it starts a Linux Docker container so Wrangler can build the Pyodide
venv; 1Password still resolves secrets on the host and passes them in as
environment variables. Linux and macOS run the Worker on the host. Set
`DEV_UI_DOCKER=1` to force Docker, or `DEV_UI_DOCKER=0` to force the host path.
The Python harness calls the real application handlers, stubs every Discord API
request, and captures model requests, responses, replies, media, logs, and D1
side effects. Model calls are real and tagged `ragbot_env: dev`. Per-run config
overrides are isolated from other simulations and saved settings.

Open Chat or `/bicture` from the navigation. The main screen contains a model
picker, temperature slider and number field, prompt, output, and **Review & save**.
Temperature uses the selected chat model’s supported range and is disabled when
unavailable. Like the model choice, it stays a draft until saved. Settings start
on **Live bot**; select Local sandbox for local-only saved settings. Choosing a model creates a
draft. Sending a prompt runs a local Discord simulation with real model inference;
only the explicit save button changes the selected destination.

Chat requests use the provider's default output allowance; there is no chat
max-tokens setting or application-supplied output-token limit.
An operator can set `reasoningEffort` in the saved chat configuration when the
selected model supports it. Choosing a different model clears this setting so
it is not sent to an incompatible model.

Model choices come from the account's live Cloudflare catalog, without a chat or
image model-name shortlist. Compatible Chat Completions and Responses models are
supported, as are synchronous text-to-image models that accept a prompt and return
an image. Models requiring extra inputs or asynchronous image jobs are excluded.
The existing Cloudflare-credit routing checks still apply. Search settings retain
the verified web-search model list. Refresh models updates the catalog.

All chat models offered in the UI use the AI binding with Cloudflare catalog
model IDs and account credits. Existing saved `grok/` and `google-ai-studio/`
names remain supported. Chat Completions and Responses keep their respective
request formats. This avoids the legacy chat compatibility endpoint, which can
forward newer models without provider credentials even when gateway
authentication succeeds.

**Advanced settings** holds system prompts, generation controls, image profiles,
and web search. **Prompt history** fetches and searches Live bot or Local sandbox
D1 prompts and loads them into the editor. A chat replay starts a new local channel;
it uses current settings without restoring historical context or attachments.
Bicture records full prompts, model, requester, timing, and outcome in the existing
`rag_ai_interactions` table after deployment. No schema migration is needed, and
history write failures do not repeat generation or prevent replies.

**Discord simulation** contains identity and channel controls with usable defaults.
Other slash commands are under **Other commands**, and captured requests, replies,
logs, and database effects are under **Request details**. Drafts and transcripts
persist in the browser; output remains available across page switches.

Source changes rebuild the Worker automatically. UI and bundled configuration
changes also reload the browser once any active request finishes, preserving drafts.
The UI has its own local database state at `.wrangler/dev-state`. Simulations use
local data. Live settings and history are read from the D1 database configured in
`wrangler.jsonc`; local settings and history use the sandbox database.

The launcher stages a separate Python bundle under `.wrangler/python-dev`,
refreshes it when source files change, and supplies resolved secrets through the
process environment. It requires the 1Password CLI; the former Node SDK resolver
has been removed. The dev worker has no routes, `workers_dev: false`, and a
`DEV_UI` guard. Production never imports or bundles the harness or UI.

## Configuration and operations

AI models, prompts, and generation settings live in `src/ragbot/ai_config`.
`pnpm run build` generates `_bundled.py`; deployment runs this automatically.
The dev UI defaults to **Live bot** settings. Choose any available model on Chat
or `/bicture`, then use **Review & save to live bot** to inspect the before/after
values and **Save to live bot** to apply them. Chat settings are shared by mentions
and `/ask`; image settings update the chosen profile. Changes remain drafts until
saved. The live bot reads saved settings immediately without a redeploy.

The editor uses the existing Cloudflare API token; live settings need D1 read/edit
permission for the configured database. All management calls stay in the local
dev Worker. The production Worker needs no management token or new endpoint.
The dev UI accepts localhost hosts only; writes require a same-origin JSON
request and a UI header. Do not expose the dev server publicly.

Each save atomically writes a complete configuration and revision to the single
`ai_runtime_settings` row. Each AI request reads that row from the D1 primary,
without a timer cache or replica session. Chat, search, and image generation use
one consistent snapshot per request, even in the long-lived gateway. A request
that reads settings after a confirmed save sees the new revision; in-flight
requests keep their original settings. A failed primary read stops inference
instead of silently serving old settings. Request details show
the revision used by each model request; unsaved overrides carry a draft suffix.

Saves condition the database update on the loaded revision. A concurrent update
is rejected atomically, including across separate dev UI processes. An uncertain
save is not automatically retried; reload first. To revert, edit and review the
old values in the UI, then save again.

To upgrade from KV settings, apply `0003_ai_runtime_settings.sql`, then run:

```sh
op run --env-file=.env -- pnpm run d1:migrate:remote
op run --env-file=.env -- uv run python scripts/migrate_ai_settings.py
op run --env-file=.env -- pnpm run deploy
```

The migration script preserves all current KV values, verifies the D1 readback,
and does nothing if settings are already present in D1. It leaves legacy KV
untouched. The new runtime reads KV/bundled defaults only when the D1 table exists
but has no settings row; a missing table is an error. The dev launcher applies
local schema migrations, and the first local save initializes its settings row.
Once D1 settings exist they take precedence over KV and future bundled changes.
Future settings edits need no redeployment.

AI has no daily budget cap, per-minute request limit, or moderation-ban checks.
`/raghammer` bans apply only to `/rag`. Historical spend and request data is retained.
`ALLOWED_GUILD_IDS` fails closed when configured; an unset value allows with a
warning. Generated-media downloads enforce a 25 MiB cap while streaming.

Operator routes require `Authorization: Bearer $GATEWAY_CONTROL_TOKEN`:
`POST /gateway/start`, `POST /gateway/stop`, and `GET /gateway/health`.
An operator stop persists across eviction and cron runs. Fatal Discord close
codes disable rapid retries; cron or an explicit start can retry.

The migration preserves the Worker name, domain, D1/KV identifiers, Durable
Object class and singleton name, storage keys, and migration history. A deployment restarts the gateway connection; the next
cron or authenticated `/gateway/start` reconnects it unless explicitly stopped.
After deployment, smoke-test `/rag`, `/ragboard`, `/ask`, mentions, and media.

## Discord conversation context

Channel mentions and replies to Ragbot follow the explicit reply chain, including
when the author switches Discord's reply ping off. Answers use Discord reply
references without pinging the author, so later replies can recover the question
and answer together. Existing older standalone bot messages cannot reconstruct
an absent link retroactively.

The configured `historyLimit` bounds reply ancestry (at most 12 messages).
Tracked AI threads also include their recent history and label an explicit reply
target. Channel conversations never fetch unrelated nearby messages. Deleted or
unavailable ancestors stop traversal; the current request can still be answered.
Speaker names, named mentions, and line breaks are preserved. Attachment labels
identify files but do not claim that their contents were sent to the model.

## Discord request reliability

The native client learns Discord bucket headers and waits on route/global
limits. Rejected requests (HTTP 429) retry using Discord's delay. GET, HEAD,
PUT, DELETE, and PATCH also retry transient network/500/502/503/504 failures.
POST requests are not replayed after ambiguous failures, avoiding duplicate
messages or threads. Each call allows at most four attempts within 25 seconds;
longer rate limits fail promptly while retaining the cooldown for later calls.
Cooldowns are local to a client, so responses from Discord remain authoritative
across Worker isolates. Logs never include request URLs, tokens or payloads.
