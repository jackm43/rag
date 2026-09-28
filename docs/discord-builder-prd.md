# Discord Builder PRD

Status: implemented browser-app pilot; see [setup and runtime contract](discord-builder-setup.md).
The final implementation uses Codex SDK in Cloudflare Containers with an outbound
model broker, private R2 hosting, trusted shared-room APIs and polling. This avoids
requiring Agents API access or Workers for Platforms. Progress is posted in a dedicated app thread under the source text channel. The setup guide defines the
configuration and runtime contract for this implementation.
Arbitrary generated server processes, WebSockets and
unrestricted infrastructure changes are outside this release.
Research checked: 2026-09-28. Owner: Ragbot maintainers.

## Outcome

A guild member asks Ragbot to build a small app, watches progress in Discord,
and opens a working, access-controlled site. A request to change Ragbot instead
produces a tested pull request for maintainers. Members can iterate on previous
builds without learning Git or deployment tooling.

First complete demonstration: “@ragbot build a wordle clone that we can play
together.” Two guild members log in, join the same room, submit guesses, see the
same authoritative game state, reconnect, and retain their progress. The secret
word is never sent to the browser before the round ends.

## Research and recommendation

| Option | What it provides | Fit and tradeoff |
| --- | --- | --- |
| [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/architecture) | Hosted Codex harness, sessions, events, optional execution environment | Candidate harness: Python Worker makes API requests and stores session references. Combine with Cloudflare execution; verify account availability before committing. |
| [OpenAI-hosted sandbox](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted) | Linux workspace, Python/Node tools, network controls, output artifacts | Avoids operating a runner. Export outputs before cleanup; a sandbox is build infrastructure, not permanent website hosting. |
| [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) | Programmatic local coding threads via TypeScript or Python | Alternative harness for more runtime control. Requires a process host outside the Python Worker; the Python package alone does not make it work in Pyodide. |
| [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) | Isolated Linux containers with command/file APIs | Preferred execution infrastructure, built on Cloudflare Containers. Adds container infrastructure and a TypeScript integration boundary; verify integration with this Python Worker in a spike. |
| [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/) | Isolated tenant Workers, dynamic dispatch, app bindings | Candidate hosting plane for generated full-stack apps. Requires new platform infrastructure; do not reinterpret the existing bot as a multi-worker deployment. |

### Selected architecture

Keep the Python Worker as the Discord control plane. A separate TypeScript
builder Worker owns durable project orchestration, authentication, publication
and room state. Cloudflare Containers run the pinned Codex SDK and build tools;
private R2 stores source and immutable releases. Generated browser apps use the
trusted room APIs for persistence and multiplayer. Containers are temporary
build environments, not the deployed website host.

[Cloudflare Containers](https://developers.cloudflare.com/containers/) provides
the Linux runtime. Its
[outbound networking controls](https://developers.cloudflare.com/containers/egress/)
allow a trusted broker to attach the OpenAI key outside the coding process.
The runner receives no Discord, GitHub, Cloudflare or OpenAI credentials.
The SDK uses the Responses API through that broker. This implementation does
not require Agents API eligibility, Sandbox SDK or Workers for Platforms.

The Python-to-TypeScript service binding is covered by a real workerd RPC test.
The actual Codex executable and container toolchain are covered by a Docker smoke
test using a local fake Responses endpoint. Provider account eligibility, billing,
real model quality and deployed wildcard DNS/TLS need verification after setup.
This feature adds no AI budget cap, spend tracking, request quota or moderation
ban checks; the existing repository invariants remain intact.

## User experience

1. `/build prompt:...` or an explicit leading `@ragbot build ...` creates a
   request. Ordinary conversation about programming stays in chat.
2. Ragbot records the request, creates an app workspace thread and links it in
   the source channel. The thread keeps the parent channel’s visibility.
   Apps require Discord guild login or a private personal passcode.
3. Agent builds from a maintained template, runs tests, and reports bounded
   progress summaries. Failure messages explain what can be retried without
   exposing logs or credentials.
4. On passing checks, the publisher releases the guild-private site and returns
   its URL. This publication is authorized by the build request and configured
   guild policy; routine sites should not require a second manual confirmation.
5. In the workspace, the owner or Mods can mention Ragbot with a bug report or
   requested change without supplying an ID. Follow-up requests create new revisions. A failed revision keeps the last
   working release. Owner and Mods can stop a job or roll back a release.
6. `/feature prompt:...` targets Ragbot's allowlisted repository. The
   agent opens a draft PR with tests and a change summary. Maintainers retain
   merge and production deployment authority; arbitrary Discord prompts cannot
   grant either capability.
7. `/buildstatus request:...` returns a safe status in the originating channel.
   No private-channel prompts or artifacts are exposed through cross-channel
   lookups. Owners and Mods may change a project; other members can play it.

## Scope

Pilot: one configured guild, responsive browser apps, a maintained multiplayer
room template, Discord login, progress/status/cancel, revisions/rollback, and
Ragbot draft PRs. Personal passcodes are included and delivered ephemerally. Do not build arbitrary infrastructure, desktop
apps, production bot self-modification, or unrestricted external integrations.

The coding agent owns application code. Trusted templates/services own login,
session verification, membership checks, deployment policy and secrets. A game
must include a server backend for room state; static assets alone do not satisfy
“play together.” Keep game state partitioned by project and room, with server-side
validation, transactional updates or a room Durable Object, and reconnect sync.

## Identity and access

Use Discord's authorization-code flow with `identify` and `guilds.members.read`.
The [OAuth2 documentation](https://docs.discord.com/developers/topics/oauth2)
allows `/users/@me/guilds/{guild.id}/member` with that member scope. The trusted
server checks the project's stored guild ID; a browser-supplied guild is never
authoritative. Discord errors, absent membership and pending membership screening
fail closed. No email or complete guild listing is needed.

Bind a short-lived, single-use OAuth state to the browser session and project;
use exact registered redirect URLs. Keep OAuth tokens server-side. Set Secure,
HttpOnly, SameSite session cookies, validate Origin on mutations,
and use CSRF protection. Give apps separate origins with host-only cookies;
never use a shared parent-domain cookie accessible to generated apps. Recheck
membership at login and at most every five minutes, during app requests; deny access if revalidation fails. Logout/revocation invalidates sessions.

Personal passcodes are high-entropy, expiring and single-use. They are issued
privately to a verified guild member and bind the resulting session to that
member. Membership is checked again at redemption and during use. Store only code
hashes, rate-limit authentication attempts and never place codes in URLs, prompts,
source bundles or public replies. Anyone receiving a code can act as its issuer
until expiry; members must keep it private. Reusable shared codes are unsupported.
Authentication attempt limits do not alter the bot's AI request policy.

Every route to an app, including assets, APIs, WebSockets, previews and default
provider URLs, must enforce access. Disable alternative public origins. Generated
code cannot edit the trusted gateway or receive Discord OAuth/bot tokens.

## Execution and deployment design

Ragbot persists a request before any external action. Idempotent service-binding
submission creates a Project Durable Object. Durable alarms drive each stage;
the Discord interaction does not stay open for the build. The bot's minute cron
reconciles remote status and updates workspace progress, while gateway maintenance
keeps its existing fifteen-minute cadence.

States: submitted → building → testing → publishing → ready. Feature requests
end in pr_ready; failures and cancellations are terminal. Revision and state
checks fence stale results across asynchronous operations. Container starts,
artifact destinations and Git branches have deterministic identities. Ambiguous
GitHub outcomes reconcile with the existing branch/PR. Cancellation is available
before publication; once publication begins members wait for completion and can
roll back or delete. Failed updates preserve the active release.

Use one sandbox per attempt, with a clean pinned template or repository snapshot.
Treat Discord prompts, dependencies and repository content as untrusted. Supply
only explicit files; exclude `.env`, local caches, history and production data.
Restrict egress and execution lifetime. Keep publishing and repository write
credentials out of agent processes. The agent exports an artifact manifest,
tests and source revision; a trusted publisher validates paths, sizes, symlinks,
file types before release. Never execute arbitrary artifact hooks in
the publisher. Use independent trusted verification in addition to agent tests.

For Ragbot changes, a repository-scoped GitHub token supplies read/write access
only to the trusted publisher. The runner receives a bounded snapshot without
credentials or git history, and runs repository checks. Protected authentication,
deployment, workflow and migration files are excluded from automatic changes.
The publisher creates a draft PR; maintainers retain merge and production
deployment authority. Generated tests and checks are useful evidence, not a
substitute for review.

D1 stores Discord request metadata and observed lifecycle; Project Durable Object
storage owns remote job state and active revisions. Private R2 retains durable
source and artifacts independently of the sandbox. Inputs and failed artifacts
expire after 24 hours, request prompts after 30 days; successful source/revisions
remain until deletion. Owners and Mods can delete projects, including room data;
source export is owner-only. Operational errors are bounded codes and never expose
prompts, tokens or raw provider errors.

## Acceptance criteria

- Duplicate Discord delivery produces one request and ultimately one build.
- DMs, unset guild configuration and other guilds cannot submit coding jobs.
- Database failure cannot report success or start external work.
- Restart/eviction during any stage recovers the job without duplicate publication.
- Public HTTP routes cannot submit/control builds; stale revisions cannot advance state.
- A non-member cannot load protected assets, call room APIs, and WebSocket requests are rejected;
  direct provider URLs do not bypass access. Cross-project sessions are rejected.
- Two members play the same room; reconnect and concurrent guesses preserve state.
- A cancelled job cannot publish; a broken update retains the prior release.
- Feature requests produce tested draft PRs without changing production Ragbot.
- Existing moderation, authentication, gateway and media tests remain green.

Proposed pilot measures: at least 8 of 10 maintained example prompts reach a
working authenticated app; request acknowledgement under Discord's interaction
deadline; progress visible within one minute while active; zero duplicate
releases and zero cross-guild access in fault-injection tests. These are targets,
not measured results. Track completion, duration and failure classes without
recording prompt content or adding AI spend tracking.

## Delivery and handover

Implemented: Discord slash commands and explicit mentions; D1 intake and live
coding configuration; service-binding orchestration; isolated Codex execution;
test and artifact validation; authenticated app publication; persistent shared
rooms and Wordle; OAuth and personal passcodes; revisions, rollback, cancellation,
source export and deletion; scoped GitHub draft PR publication; recovery and
retention alarms; local tests and deployment packaging.

The remaining operator tasks are documented in
[the setup guide](discord-builder-setup.md): connect Cloudflare resources and a
wildcard domain/TLS, supply OpenAI and Discord OAuth credentials and the scoped
GitHub token, then run the setup/deployment and command-registration commands.
The setup script provisions the bucket, uploads secrets, applies additive D1
migrations and deploys in compatibility order. No production deployment or paid
provider request was performed during implementation. Run the documented live
acceptance smoke after connecting the accounts; local tests cannot establish
account permissions, live DNS or actual model output quality.
