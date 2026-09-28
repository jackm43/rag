# Discord app builder

Members ask Ragbot for a web app in Discord and get a link to a working app
that only members of the server can open. Anything that runs in a browser is
fair game: a one-off site, a multiplayer game, a three.js demo, a tool.

## Using it

- `@Ragbot build a pixel-art guestbook for the server` (or `/build prompt:...`)
  in a server text channel. Ragbot opens a workspace thread, builds the app and
  posts its link and a short summary there, usually within a few minutes.
- In the thread, the app's owner or Mods mention Ragbot with a change:
  `@Ragbot make the board bigger and add sound`. Each change is a new revision
  at the same URL; the previous version stays live until the new one is ready,
  and stays live if the change fails. `@Ragbot status` reports progress. Other
  messages in the thread are ordinary discussion.
- `/buildstatus`, `/buildedit`, `/buildcancel`, `/buildrollback revision:N` and
  `/builddelete` manage an app. In its thread no ID is needed; elsewhere use the
  build ID from the channel where it was requested.
- `https://apps.jsmunro.me/` lists the server's apps after signing in.

## How it works

```text
Discord ── ragbot-worker (Python) ──service binding──▶ ragbot-builder (TypeScript)
             D1 build_requests                           BuilderControl  (RPC only)
             cron: post results once                     Project DO      one per app: builds, revisions, rollback
                                                         BuildContainer  Cloudflare Container: supervisor + Codex
                                                           └─ egress ──▶ AI Gateway (token added here) / npm only
                                                         R2 (private)    published files + source per revision
                                                         Auth DO         Discord OAuth state and sessions
                                                         Rooms DO        one per app: WebSocket rooms, shared state
                                                           └─ LOADER ──▶ Dynamic Worker: the app's server/room.js
                                                         Directory DO    URL slugs and the hub listing
Browser ─────────────────────────────────────────────▶ https://apps.jsmunro.me/<app>/  (members only)
```

1. The bot records the request in D1 (idempotent per Discord message) and calls
   `BuilderControl.submit`. The builder has no public control routes.
2. The app's `Project` Durable Object starts a container for the revision. The
   supervisor copies the template (`builder/template`), restores the previous
   revision's source for a change, and runs Codex as an unprivileged user with
   the template's `AGENTS.md` as its instructions. Codex may run `npm install`,
   `npm run build` and `npm test`; if the checks fail it gets two attempts to
   fix them. The supervisor then re-runs the build and tests itself, stops
   anything the agent left running, and lists `dist/`.
3. The Durable Object validates the file list (paths, 400 files, 10 MiB each,
   25 MiB total), copies the files and a source archive to R2, and marks the
   revision live. Builds that fail, time out (45 minutes) or lose their
   container more than twice are reported as failed.
4. The bot's per-minute cron polls unfinished builds and posts each result once
   (claimed in D1 first, so an uncertain Discord POST is never repeated). Model
   written titles and summaries pass through the reply policy: no mentions,
   raw IDs or link embeds.

## Inference through AI Gateway

There is no OpenAI API key anywhere. Codex in the container is configured the
way Cloudflare documents for Codex: a Responses API provider at
`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`, with a
placeholder key. Every request the container makes is intercepted by the
builder Worker's outbound handler, which for that path only:

- drops the placeholder `Authorization` header (and any `x-api-key` or cookie),
- adds `cf-aig-authorization: Bearer $CF_AIG_TOKEN` and `cf-aig-metadata`,
- pins `model` to `CODING_MODEL`, and forwards the stream unbuffered.

AI Gateway then bills the request through Unified Billing credits, or uses an
OpenAI key stored on the gateway (BYOK) if one is configured. Neither needs a
code change. The only other host a build can reach is `registry.npmjs.org`
(reads only); everything else is refused, so the container holds no secrets and
cannot send data anywhere else.

`CODING_MODEL` (default `gpt-5.5`) and `CODING_REASONING_EFFORT` are Wrangler
vars in `builder/wrangler.jsonc`. Codex works with OpenAI Responses models.
Unified Billing allows 200 requests per minute per gateway, so consider a
dedicated gateway for builds (`AI_GATEWAY_ID`). Spend limits, if wanted, are
configured on the gateway rather than in this code. Gateway logs include
prompts and generated code.

## Access: Discord members only

- The only way in is Discord OAuth (`identify guilds.members.read`, `prompt=none`
  so returning members skip the consent screen). Login state is single-use,
  bound to the browser and expires in ten minutes. A session is issued only to
  a full (not pending) member of a configured guild.
- Membership of the app's guild is checked again at least every five minutes
  using the member's own token; a failed or denied check ends access.
- Every path under an app requires it: pages, assets, `_api`, and WebSocket
  upgrades. Anything that changes state, including WebSocket upgrades, must come
  from the apps origin (`Origin` check). Cookies are `__Host-`, `Secure`,
  `HttpOnly`, `SameSite=Lax` and last at most eight hours.
- The Worker answers only on `APP_ORIGIN`: `workers_dev` and preview URLs are
  off, and the R2 bucket stays private.
- All apps share one origin, so one sign-in covers them all. The trade-off is
  that an app's code runs as the signed-in member on that origin and could call
  another app's room API. Every viewer is already a verified member, so this
  stays inside the server; room state is not a place for secrets.

## What generated apps can use

The agent-facing contract is `builder/template/AGENTS.md`; the host SDK is
`builder/template/src/ragbot.js`.

- Vite and any npm packages (three.js is pre-cached in the image). Output is
  served from `/<app>/` with relative URLs, so apps use `base: "./"`.
- Content security policy: scripts, styles, fonts, media and connections to the
  apps origin only, plus Discord avatar images. No CDNs or third-party APIs.
- `GET ./_api/me` → `{id, name, avatar}` for the signed-in member.
- Realtime rooms at `./_api/rooms/<name>` (WebSocket): presence (`join`/`leave`),
  relayed messages (up to 64 KiB, not stored) and shared JSON state (up to
  128 KiB, stored, with versioned updates and conflict detection). `GET` and
  `PUT` on the same path read and write the state over HTTP.
- Optional server logic in `server/room.js`, for rules players must not see or
  bend (hidden answers, private hands, turn order, timers). It exports any of
  `join`, `leave`, `message` and `tick`; see below.

### Server logic

The runner bundles `server/room.js` (with anything it imports) using esbuild,
running as the agent user, and checks that it exports only the four handlers.
The bundle is stored in R2 with the revision and never served as an asset.

When a room of that app is used, the Rooms object loads the bundle into a
[Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) (Worker
Loader binding `LOADER`), one per app revision, with `globalOutbound: null` (no
`fetch` or other network), no bindings, and a 100 ms CPU limit per event. The
host also abandons any call after two seconds. Each event receives the room's
public state and a private `secret`; the host validates what comes back (state
128 KiB, secret 256 KiB, up to 200 messages of 64 KiB) and then stores it,
broadcasts the state and delivers messages, to one connection or everyone.
Events for one room run one at a time. A handler that throws, times out or
returns something invalid changes nothing, and the sender gets `server_error`.

With server logic, clients cannot write the state (`setState` and HTTP `PUT`
are refused) and `room.send` goes to the logic instead of other players. `tick`
runs after `room.wakeIn(ms)` from the Rooms object's alarm, only while someone
is connected. Sockets keep the revision they connected with; after a new
release or rollback, reconnecting picks up the new logic.

Dynamic Workers are in open beta on Workers Paid and are billed per distinct
Worker in use (here, one per app revision with server logic) beyond a monthly
allowance, plus normal request and CPU pricing; check Cloudflare's Dynamic
Workers pricing page before enabling it widely. Locally (`wrangler dev`,
vitest) the CPU limit is not enforced; the wall-clock bound is.

## One-time setup

1. **Cloudflare.** Workers Paid (for Containers) and R2 on the bot's account.
   The builder serves `apps.jsmunro.me` as a Worker custom domain (Wrangler
   creates the DNS record and certificate on deploy). To use another host,
   change `APP_ORIGIN` and `routes` in `builder/wrangler.jsonc` together.
2. **AI Gateway.** Use the existing `platy` gateway or create one for builds and
   set `AI_GATEWAY_ID`. Authentication must be on. Either buy Unified Billing
   credits or add an OpenAI provider key to the gateway. `CF_AIG_TOKEN` (the
   bot's existing token) needs the AI Gateway Run permission.
3. **Discord.** In the application's OAuth2 settings add the redirect
   `https://apps.jsmunro.me/_auth/callback` and store the client secret in
   1Password. In build channels the bot needs View Channel, Send Messages,
   Create Public Threads and Send Messages in Threads.
4. **Deploy the builder.** Copy `builder/.env.example` to `.env.builder` at the
   repository root, point it at the client secret, then run (Docker must be
   running; the container image is built locally):

   ```sh
   op run --env-file=.env --env-file=.env.builder -- uv run python scripts/setup_builder.py
   ```

   It creates the private bucket if needed, deploys the Worker and container,
   and uploads `DISCORD_CLIENT_SECRET` and `CF_AIG_TOKEN` as secrets.
5. **Connect the bot.** Apply the D1 migration, set `BUILDER_ENABLED` to `"true"`
   in `wrangler.jsonc`, deploy, and register commands when you want them:

   ```sh
   op run --env-file=.env -- pnpm run d1:migrate:remote
   op run --env-file=.env -- pnpm run deploy
   op run --env-file=.env -- pnpm run register:commands
   ```

Setting `BUILDER_ENABLED` back to `"false"` stops new builds; published apps keep
working. The cron runs every minute for build results; gateway maintenance keeps
its fifteen-minute cadence.

## Verification

```sh
pnpm --dir builder check                 # TypeScript
pnpm --dir builder test                  # Workers runtime: builds, auth, rooms, egress
node --test builder/runner/server.test.mjs
pnpm test                                # bot: intake, threads, mentions, commands, results
pnpm --dir builder e2e                   # everything together, see below
```

`pnpm --dir builder e2e` needs Docker, `openssl`, a Chromium build for
Playwright (`npx playwright@1.56.1 install chromium`, or set `E2E_CHROMIUM`)
and permission to bind port 443. It builds the real image and runs the builder
under `wrangler dev` with Cloudflare's local container egress interception.
Only AI Gateway and Discord are replaced, by local fakes (`builder/test`), and
the fake model drives the real Codex binary through tool calls. It checks:

- the build publishes a three.js app, and every model request reached "AI
  Gateway" with `cf-aig-authorization` and without the placeholder key;
- anonymous, cross-site and path-traversal requests are refused;
- server logic (a secret-number game): a guess gets a private hint the other
  player never receives, the room state never contains the answer, clients
  cannot overwrite server-owned state, and the logic survives a revision;
- two members sign in through the Discord OAuth redirect flow, see each other's
  presence and share state live in real browsers, and the state survives a
  reload;
- a non-member is refused a session;
- only the owner or a Mod can manage the app;
- a revision restores the saved source, then rolls back;
- deletion removes the app and its hub entry.

`builder/test/container-smoke.mjs` runs the image alone with networking
disabled. In a build environment that intercepts TLS, pass its CA as the
`E2E_BUILD_CA` path (or `docker build --secret id=ca,src=...`).

Real model quality, AI Gateway billing and the live Discord application still
need checking after deployment: request one app, open it as two members and as
a non-member, request a change, and delete it.
