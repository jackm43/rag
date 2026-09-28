# Connect and deploy Discord Builder

The code is included in this repository. Setup needs Cloudflare, Discord,
OpenAI and GitHub account configuration. No hosted Codex/Agents API integration
is required: the pinned Codex SDK runs in Cloudflare Containers and calls the
Responses API through a trusted credential-injecting outbound handler.

## Account setup

1. **Cloudflare:** enable Workers Paid, Containers, Durable Objects and R2 on
   the bot's existing account. Choose an app domain in a Cloudflare-managed
   zone. Add proxied wildcard DNS and ensure the certificate covers
   `*.APP_DOMAIN` (including `login.APP_DOMAIN`). For nested subdomains this
   may require an advanced certificate or a dedicated zone. Keep the R2 bucket
   private: no `r2.dev` URL, public bucket or custom bucket domain.
2. **OpenAI:** create a project API key permitted to use Responses and the
   configured coding model. The default is `gpt-6-sol`; model and instructions
   use `coding-agent.json` through the bot’s D1-backed ConfigStore. Each new build
   or revision captures a fresh settings snapshot. This uses the OpenAI API account, not existing Cloudflare
   model credits or a personal ChatGPT login.
3. **Discord:** in the existing application's OAuth2 configuration, register
   `https://login.APP_DOMAIN/_auth/callback` exactly. Supply its client secret
   and the existing bot token. Grant View Channel, Send Messages, Create Public
   Threads, and Send Messages in Threads in the channels used for builds. Login requests `identify guilds.members.read`;
   no email scope. The bot must remain a member of the configured guild.
4. **GitHub:** create a fine-grained token limited to the Ragbot repository,
   with Contents read/write and Pull requests read/write. Configure the repo
   and base branch. The token is used by the trusted Worker only. Protect the
   base branch and require review; builds never merge or deploy Ragbot changes.
   Leave GitHub Actions requiring maintainer approval for bot-created code;
   do not expose CI/deployment secrets to generated code.
5. **Deployment token:** the existing Cloudflare token needs Workers scripts,
   Containers/image deployment, Durable Objects, R2, D1 migrations and routes
   permissions for the configured account/zone. Docker Desktop must be running
   when deploying the container image.

## Supply configuration and deploy

Copy `builder/.env.example` to `.env.builder` at the repository root. Set the
non-secret domain/repository values and replace the `op://` references with
your 1Password item references. Existing Discord and Cloudflare values are
loaded from `.env`. Do not put resolved secrets in tracked files.

```sh
op run --env-file=.env --env-file=.env.builder -- uv run python scripts/setup_builder.py
op run --env-file=.env --env-file=.env.builder -- uv run python scripts/setup_builder.py --apply
```

The first command validates settings. The second writes non-secret Wrangler
settings, creates the private artifact bucket if absent, installs the locked
builder dependencies, deploys the builder and container, uploads secrets,
deploys the backward-compatible bot reader, applies additive D1 migrations,
enables the service binding, regenerates types,
and deploys Ragbot. It preserves the existing gateway and resource IDs.
If a stage fails, fix account permissions/configuration and rerun; successful
stages can be repeated. A live provider smoke test remains necessary after
account setup; local verification uses fake providers and spends nothing.

When ready to expose the new commands, explicitly run:

```sh
op run --env-file=.env -- pnpm run register:commands
```

Command registration is deliberately separate, following this repository's
registration rule. Build mentions work after deployment without registration.

## Using it

- `@ragbot build a wordle clone we can play together` or `/build prompt:...`:
  create a build and a named workspace thread within the originating text channel.
  Ragbot links the thread in its reply and posts progress and the app URL there.
  Threads inherit the parent channel’s visibility; a private channel stays private.
- `/feature prompt:...`: implement a repository change and open a draft PR.
- `/buildstatus request:...`: refresh status and show the current release URL.
- `/buildedit request:... prompt:...`: build a revision from the saved source.
  Requester and Mods can manage builds. A failed revision keeps the old app live.
- `/buildcancel request:...`: stop an active build. Once publication starts,
  wait for it to finish and then roll back or delete; a committed publication
  cannot be cancelled halfway through.
- `/buildrollback request:... revision:...`: restore an earlier site release.
- `/buildpass request:...`: receive an **ephemeral**, personal, one-use code.
  Enter it on the app's login page within ten minutes. It represents the issuing
  Discord member and must not be shared. Discord membership is checked again
  on redemption and periodically during the session.
- `/builddelete request:...`: remove the site, saved source and room data after
  the build stops. Existing GitHub PRs remain for normal repository review.
- `https://PROJECT.APP_DOMAIN/_source`: requester-only source download after
  login. Feature-repository source is never served through an app hostname.

### Request changes in the app thread

The app owner or Mods can write `@ragbot fix the keyboard after an invalid guess`
or `@ragbot add a leaderboard`. Ragbot resolves the app from the thread, builds
from its saved source and publishes a revision at the same URL. Other members
can discuss bugs there; only the owner and Mods can trigger changes. Mention the
actual bot, rather than typing its name as plain text. Ordinary discussion does
not start a build. `@ragbot status` reports progress.

Inside the workspace, omit `request:` from `/buildstatus`, `/buildedit`,
`/buildcancel`, `/buildrollback`, `/buildpass` and `/builddelete`. Passcodes remain
ephemeral. Outside it, use the original request ID from the originating channel.
An in-progress build must finish or be cancelled before another edit starts;
follow-up requests are not silently queued.

For an existing app, `/buildstatus request:ID` in its original channel creates
and links its workspace on first use. Apply migration `0007_build_threads.sql`
before deploying this version, and register the updated slash-command definitions
when ready. The setup script applies migrations automatically.

If thread creation fails, the app build continues and the ID-based commands stay
available. Ambiguous Discord POST failures are never automatically retried. Builds
requested inside an existing thread or a non-text channel do not create broader
sibling threads; use ID-based commands there. Archived workspace threads can be
reopened in Discord, subject to channel permissions.

Discord documents [thread permission inheritance](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx).

## Implemented application runtime

Generated apps use HTML, CSS, JavaScript, JSON and SVG assets, served from R2
behind authentication. They can implement games, dashboards, tools and other
browser experiences with durable shared data. Every project has its own origin.
The agent receives documented host APIs:

- `GET /_room/NAME` → `{version, data}`.
- `PUT /_room/NAME` with `{version, data}` → updated state; stale versions return
  HTTP 409. State is shared by authenticated project members; keep secrets out
  of this general-purpose room data. Maximum request body: 32 KB.
- `GET /_wordle/NAME` → shared board; the answer is hidden until the round ends.
- `POST /_wordle/NAME` with `{version, guess}` → validated move, or HTTP 409
  after a concurrent move. `{version, reset:true}` starts a new completed-round
  game. Guesses accept five-letter alphabetic words; the built-in answer list
  is intentionally compact.

Clients poll for changes (the starter uses two seconds). This release does not
host arbitrary generated server processes or external integrations. Those are
outside the supported app runtime, not account-configuration steps. The coding
agent can change the browser app and use the supplied durable APIs; it cannot
change the trusted authentication or room services. No Workers for Platforms
subscription is needed for this runtime.

## Isolation and operations

The Python bot remains the gateway/Discord application. A new TypeScript
`ragbot-builder` Worker owns project, auth, room and container Durable Objects,
and a private R2 bucket. One container runs each project revision. Build polling
uses DO alarms; bot progress reconciliation runs each minute while gateway
maintenance retains its 15-minute cadence. No public job-control HTTP endpoint
exists; control uses a named service-binding entrypoint.

Containers run generated code as UID 1000; the supervisor runs separately.
The OpenAI key is injected outside the container at the fixed provider endpoint.
Container egress permits only the model broker and package/source download
hosts. GitHub and Discord credentials never enter the container. External app
requests are limited by CSP to the app's own origin. Membership checks fail
closed and repeat at most five minutes apart. Sessions expire within eight hours.

Artifacts are bounded text bundles (up to 500 source files and 4 MiB collected
source; total exported payload at most 6 MiB), with symlink/path checks. Build
execution has a 40-minute lifecycle deadline. Container capacity is configured
in Wrangler; this does not add a bot AI budget or request quota. No spend data
is recorded. A capacity/runner error leaves a failed request that can be retried
with `/buildedit`.

Feature builds run the repository's check, test and runtime-test commands in the
container. Changes to CI, deployment, migrations, authentication entrypoints and
builder infrastructure are rejected by the publisher; those changes need normal
maintainer development. Draft PRs use deterministic branch names and are looked
up before creation so an uncertain response can be reconciled.

Keep successful app/source revisions until project deletion. Request prompts are
redacted in D1 after 30 days and in the builder 30 days after completion. Failed
artifacts and staging inputs are removed after 24 hours. Short-lived auth state and sessions
are cleaned by alarms. Roll back by disabling the builder on this code version; pre-builder code does
not understand the expanded settings snapshot. Disable `BUILDER_ENABLED` to stop new submissions from
the bot; cancel existing jobs individually before suspending the builder.

## Local verification

```sh
pnpm install
pnpm --dir builder install --frozen-lockfile
pnpm run check
pnpm test
pnpm run test:runtime
pnpm --dir builder check
pnpm --dir builder test
node --test builder/runner/server.test.mjs
pnpm --dir builder dry-run
uv run pywrangler deploy --dry-run

docker build -t ragbot-builder-local builder
docker run --rm --network none \
  -v "$PWD/builder/test/container-smoke.mjs:/test/container-smoke.mjs:ro" \
  ragbot-builder-local node /test/container-smoke.mjs
```

Use the repository-local uv (0.12.3+) if the system uv is older. Workerd tests
exercise job persistence, duplicate delivery, OAuth state/tickets, membership
revocation, project isolation, two-member room concurrency and rollback with
fake external services. The Docker smoke runs the real Codex binary against a
local fake Responses endpoint, then runs tests and collects the starter app.
It does not measure real model build quality or validate account permissions.
After connecting accounts, submit one site and one feature request, verify login
with two guild members and denial for a non-member, and check that the PR stays
a draft and the production bot is unchanged.
