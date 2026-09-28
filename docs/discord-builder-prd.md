# Discord app builder: product requirements

Status: implemented and verified locally end to end; see the
[setup and runtime guide](discord-builder-setup.md). Updated 2026-09-28.

## Outcome

A member of the server mentions Ragbot with an idea and, a few minutes later,
has a link to a working web app that any member can open and nobody else can.
The app can be anything a browser runs: a one-off site, a game to play together,
a three.js demo, a small tool. Members iterate on it by talking to Ragbot in the
app's thread, without Git, hosting or deployment knowledge.

## Requirements

1. **Discord first.** `@Ragbot build <idea>` in a server channel starts a build
   and opens a workspace thread; results arrive there. `/build` mirrors it.
   Other mentions stay ordinary chat.
2. **Any browser app.** No fixed catalogue: a maintained Vite template, npm
   packages, static assets, host-provided identity and realtime rooms for
   multiplayer, and optional sandboxed server logic for rules and secrets.
   Nothing specific to one game lives in the host.
3. **Always Discord-gated.** Every page, asset, API call and WebSocket of every
   app requires Discord OAuth and current membership of the app's guild,
   re-verified at least every five minutes. There is no other way in: no
   shareable codes, public URLs or preview hosts.
4. **Iteration.** In the thread, the owner or Mods describe a change; it builds
   from the saved source as a new revision at the same URL. Failed revisions
   keep the last working one live. Rollback, cancel and delete are available.
5. **No provider keys.** Inference goes through Cloudflare AI Gateway, paid by
   Unified Billing or a key stored on the gateway. The build environment never
   holds a credential.
6. **Safe by construction.** Prompts and generated code are untrusted. Builds
   run in an isolated container with egress limited to AI Gateway (through a
   credential-injecting handler) and the npm registry, as an unprivileged user.
   The host validates build output before publishing it.
7. **Reliable in Discord.** Duplicate deliveries create one build; ambiguous
   Discord POSTs are never retried; each result is posted once; database
   failures never report success; the bot's existing behaviour is unchanged.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where builds run | Cloudflare Containers driven by a Durable Object per app | Linux toolchain for npm/Vite and a coding agent; durable, restartable orchestration without a separate queue. |
| Coding agent | Codex CLI via its SDK, OpenAI Responses models | Cloudflare documents Codex with AI Gateway; runs non-interactively with a repair loop. |
| Credentials | Container outbound handler adds `cf-aig-authorization` | Nothing to steal in the container; one token, already used by the bot. |
| Hosting | Private R2, served by the builder Worker at `apps.<domain>/<app>/` | One sign-in for all apps and one OAuth redirect; no wildcard DNS or certificates. Apps share an origin, which is acceptable because every viewer is a verified member. |
| Multiplayer | One Durable Object per app with hibernating WebSocket rooms, presence, relay and versioned shared state | Covers most friend-group games and tools with no generated server code. |
| Server rules and secrets | Optional `server/room.js` run by the Rooms object in a Dynamic Worker per app revision: no network, no bindings, CPU-limited; the host keeps state and delivers messages | Games can hide answers and enforce rules without generated code touching storage, sockets or the network. Simpler than Durable Object Facets and easy to test. |
| Access | Discord OAuth only, per-guild membership cache of at most five minutes | Meets the "members only" rule; the earlier shareable passcodes were removed because anyone holding one could get in. |
| Scope cut | Ragbot self-modification (draft PRs) removed from this release | Not needed for apps; it carried a repository write token and ran the repository's own checks in the container. |

## Acceptance (all covered by automated tests)

- A build request creates one D1 row, one builder job and one thread, even when
  delivered twice; DMs, other guilds and an unset guild list are refused.
- A built app is published with its summary posted once to the thread.
- An anonymous visitor, a non-member and a cross-site page cannot load assets,
  call the API or open a WebSocket; membership loss ends access within five
  minutes.
- Two members in real browsers see each other's presence and shared state live,
  and the state survives reloads.
- With server logic, a player's private hint never reaches another player, the
  answer never appears in room state, and clients cannot overwrite server-owned
  state; broken, networked or never-finishing logic changes nothing.
- A revision builds from the previous source; a failed revision keeps the old
  release; rollback and deletion work; only the owner or Mods can manage.
- Model requests reach AI Gateway with the gateway token and without any
  placeholder or provider key, using the configured model.

## Next

- Live checks after deployment: real model output quality, gateway billing, and
  the Discord OAuth application.
