# Discord gateway review — 5 October 2026

## Scope

Compared `src/ragbot/gateway.py` and the `DiscordGateway` entrypoint in
`src/entry.py` with
[`dcartertwo/discord-gateway-cloudflare-do`](https://github.com/dcartertwo/discord-gateway-cloudflare-do)
at commit `f459388` ("harden gateway reconnect and protocol handling"). That
project is a TypeScript Durable Object that keeps one Discord gateway WebSocket
open and forwards a few dispatch types to a webhook. The review covers connection
lifecycle, protocol handling, persistence, scheduling and safety. It does not
cover the forwarding format, because ragbot handles events in the same process.

Platform facts used below come from Cloudflare's Durable Object lifecycle
documentation, current as of this review. Pending `setTimeout` timers, outbound
fetches and outbound WebSockets prevent eviction for up to 15 minutes from when
each one starts. A later operation extends that window. Objects still restart for
deployments and runtime updates. Discord resets the bot token when an
application exceeds its daily `session_start_limit` of IDENTIFY calls.

## How the two implementations differ

| Area | Reference DO | ragbot before this change | Decision |
| --- | --- | --- | --- |
| Reconnect delay | Exponential, 2 s doubling to a 5 min cap, plus jitter. It resets on READY or RESUMED. | Fixed 5 s, forever. | **Adopt.** Use exponential backoff with jitter and reset it on READY or RESUMED. |
| Session start limit | Reads `GET /gateway/bot` and waits for `reset_after` when `remaining` reaches 0. | Not checked. A tight IDENTIFY loop could spend the 1,000/day budget in about an hour, after which Discord resets the token. | **Adopt.** Check the budget before every IDENTIFY and use the returned URL after host validation. |
| Session persistence | Stores session id, resume URL and sequence in DO storage, so it can RESUME after eviction. | Memory only. Every restart or deployment IDENTIFYs, and mentions sent while disconnected are lost. | **Adopt.** Use storage key `gatewaySession`. Flush the sequence on heartbeat ACK, not on every dispatch: replayed events are already deduplicated by `processed:` markers. |
| Close 4003 | Not resumable. | Resumable. | **Adopt.** Add 4003 to the non-resumable codes. |
| Invalid session (op 9) | Waits a random 1–5 s, as Discord requires. | Waits 5 s. | **Adopt.** Wait 1–5 s, and never less than the backoff, so repeated op 9 loops slow down. |
| First heartbeat | Sent after `interval × jitter`. | Sent immediately on Hello. | **Adopt.** Use jitter as Discord recommends. |
| Missed heartbeat ACK | Reconnects after 2× the interval. | Reconnects if no ACK arrived before the next beat. | **Keep ours.** It is Discord's documented zombie-connection rule. |
| Alarm failures | Catches errors and reschedules a fallback alarm, so the alarm is not lost after the runtime's retries. | An exception lost the watchdog until the next cron, up to 15 min later. | **Adopt.** Re-arm the watchdog on failure. |
| Recovery after restart | Heartbeat alarms, about every 41 s, notice the lost socket. | 5 min watchdog alarm, plus a 15 min cron. | **Adapt.** Use a 60 s watchdog so a restart reconnects before a typical session expires. Keep heartbeats on in-process timers. |
| Socket open | `fetch()` with `Upgrade: websocket`, which shows the HTTP status. | `new WebSocket(url)`; every failed handshake looked like close 1006. | **Adopt.** Use a fetch upgrade. A 408, 429 or 5xx backs off and respects `Retry-After`. A refused resume host starts a new session. Other refusals stop rapid retries, like fatal close codes. |
| Status | Returns status, session id, connected time, sequence and attempts. | Returns connected, resumable and stopped. | **Defer** to phase 2. Add diagnostics without exposing secrets. |
| Event delivery | Sends an HTTP POST with a shared secret to a webhook. | In-process `Application.handle_message`. | **Do not adopt.** AGENTS.md forbids internal hops. |
| Credentials | Bot token stored in DO storage through `connect()`. | Token read from Worker secrets. | **Do not adopt.** Secrets stay out of durable storage. |
| Instances | One per name, chosen by the caller. | Singleton `discord-gateway-v2`; stale instances are retired. | **Do not adopt.** The singleton and retirement are invariants. |
| Processing order | Promise queue serializes message handling. | Synchronous `on_message`; slow work runs in background tasks. | **Already equivalent.** |
| Stale sockets | Ignores events from a replaced socket. | Same identity check. | **Already equivalent.** |
| Fatal close codes | 4004 and 4010–4014 disable reconnects until an explicit connect. | Same codes, and cron may retry. | **Keep ours.** Cron retry is a documented invariant. |
| Storage backend | SQLite-backed class. | KV-backed `new_classes` v1. | **Keep ours.** Migration history must not change. |

## Defects found in ragbot during the review

1. **Unbounded IDENTIFY rate.** Fixed 5 s retries with no session start check
   could get the bot token reset. This happens when READY is followed by a
   non-resumable close or `op 9 d=false` in a loop.
2. **Restarts drop events.** With no persisted session, a deployment or runtime
   restart always re-IDENTIFIES. Messages sent while the gateway is down are
   never replayed.
3. **The marker sweep can exceed storage limits.** `storage.delete()` accepts at
   most 128 keys. A busy channel can have more stale `processed:` markers than
   that at once. The resulting exception also lost the watchdog alarm.
4. **Cron and watchdog skip backoff.** A pending reconnect timer was cleared and
   replaced by an immediate connect.

## Plan

### Phase 1 — protocol and resilience parity (this branch)

- [x] Exponential reconnect backoff with jitter, reset on READY and RESUMED. An
  explicit `/gateway/start` also resets it. Cron and the watchdog leave a
  pending reconnect alone.
- [x] Op 9: wait a random 1–5 s, and never less than the backoff. Op 7: prompt
  reconnect and RESUME.
- [x] Close code 4003 is not resumable.
- [x] First heartbeat after `interval × random()`.
- [x] Persist `{sessionId, resumeUrl, sequence}` under `gatewaySession`. Restore
  it on initialization. Clear it on stop, fatal and non-resumable closes, and
  `op 9 d=false`.
- [x] Check Discord's session start limit with `GET /gateway/bot` before
  IDENTIFY. Defer until `reset_after` when it is spent. Accept only `wss` URLs
  on `*.discord.gg`.
- [x] 60 s watchdog. Sweep markers at most hourly, deleting in chunks of 128.
  Re-arm the watchdog when the alarm fails.
- [x] Behaviour tests with an injected socket and storage. The runtime probe
  stubs `/gateway/bot`, so no test contacts Discord. It also checks that
  `gatewaySession` survives the real Durable Object storage round trip.
- [x] Open the socket with a `fetch()` upgrade and classify refused
  handshakes by status. The runtime probe connects through the upgrade and
  checks that a refused one reports its status and `Retry-After`.
- [ ] Run `pnpm run test:runtime` and the deployment dry run. These did not run
  in the authoring sandbox because its network policy blocks
  `index.pyodide.org`. CI runs both on pull requests.

### Phase 2 — operability (proposed)

- Add `reconnectAttempts`, `enabled` (false after a fatal close) and the last
  close code to `/gateway/health`. Keep session ids and tokens out of the
  response.
- Write `processed:` markers only for messages that can produce a reply. This
  cuts a storage write per guild message, but needs the relevance check moved
  ahead of `Application.handle_message`.

### Not planned

Webhook forwarding, credentials in Durable Object storage, multiple named
instances, alarm-driven heartbeats, and a per-dispatch sequence write. The
table above gives the reasons.
