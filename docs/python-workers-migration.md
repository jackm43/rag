# Python Workers migration

## Library choice

The previous project used `discord-api-types` and a custom REST/gateway client,
not discord.js. `discord-typings==0.9.0` is the equivalent Python dependency:
TypedDict definitions with only `typing_extensions` as a dependency. It imports
successfully in the actual Python Workers runtime.

`discord.py` is a full bot framework, but depends on `aiohttp` and, on newer
Python, `audioop-lts`. Its gateway owns an asyncio network lifecycle rather than
a Workers Durable Object. Importing a package is not evidence that its
networking and reconnect behavior work in Workers. This migration therefore
uses wire typings plus a small Workers-native async client. It does not claim
that discord.py is categorically impossible to adapt.

Sources reviewed:
- https://developers.cloudflare.com/workers/languages/python/
- https://developers.cloudflare.com/workers/languages/python/packages/
- https://developers.cloudflare.com/workers/languages/python/ffi/
- https://github.com/Bluenix2/discord-typings/
- https://github.com/Rapptz/discord.py/blob/master/requirements.txt
- https://github.com/cloudflare/python-workers-examples/tree/main/websocket-stream-consumer

## Refactoring

- WorkerEntrypoint/ DurableObject classes expose platform entrypoints.
- The command decorator stores definitions and async handlers together; the
  registration script reads this registry without booting the Worker runtime.
- `Application` composes `Database`, `DiscordClient`, `ConfigStore`, and
  `Inference`. Tests and the local UI inject a transport instead of replacing
  global fetch or importing development code into production.
- Dataclasses model attachments, attribution, completions, and chat jobs.
- D1/AI/Durable Object SDK bindings take ordinary Python values. Explicit
  `to_js` conversion is reserved for raw JavaScript APIs; applying it to wrapped
  D1 statements creates invalid borrowed proxies.
- Ed25519 verification uses Web Crypto on exact request bytes. It retains the
  five-minute timestamp window. Bearer comparison uses `hmac.compare_digest`.
- Application logs contain event names/statuses, not request bodies, tokens,
  headers, or arbitrary third-party exception strings.
- JSON/Markdown configuration stays editable; the build embeds it into a Python
  module because Python Worker modules do not provide arbitrary packaged files.

## Validation and rollout

`pnpm test` exercises commands, SQL transactions, guards, configuration,
reconciliation, message handling, output policy, streaming caps, gateway state,
and local simulations. `pnpm run test:runtime` stages an isolated worker with
local D1, test credentials, and stubbed Discord/AI responses. It exercises
production HTTP authentication, Durable Object storage/control, real D1 batch
conversion, slash commands, analytics, multipart bodies, and a local Discord-like
WebSocket handshake. It makes no live Discord or AI calls.

`uv run pywrangler deploy --dry-run` validates the production bundle without
publishing. Real Discord reconnects and paid model calls still require a
post-deployment smoke test. No deployment, Discord command registration, remote
migration, or Cloudflare resource removal is part of the code migration.

The existing Durable Object class name (`DiscordGateway`), singleton
(`discord-gateway-v2`), and persistent keys are unchanged. Existing D1 migrations
are unchanged. The legacy Node debugging launcher is replaced by `op run` and a
Python launcher; users need the 1Password CLI rather than its Node SDK fallback.
