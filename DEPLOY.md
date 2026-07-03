# Deploy runbook — `feature/security-architecture`

**The full stack is LIVE as of 2026-07-03.** The monolith cutover happened
earlier that day; the same evening the brain→workflows rename was cut over, and
the connectors broker + webhooks workers were deployed for the first time. Read
`STATUS.md` for the architecture; the sections below record the live state, the
secrets inventory, and the per-surface operator checklists that remain.

**Account:** `jackm` / `314e7e015b5f4429c4e2da1e6ec93271`. **Zone:** `jsmunro.me`
= `0317fdb8f32686c5173f4bcd7c5d1690`.

## Live state (2026-07-03)

Deployed workers: `ragbot-worker` (gateway), `ragbot-workflows-worker`,
`ragbot-responder-worker`, `ragbot-spend-worker`, `ragbot-registry-worker`,
`ragbot-connectors-worker`, `ragbot-webhooks-worker` (`webhooks.jsmunro.me`),
`ragbot-dev-proxy-worker` (`ragbot-dev.jsmunro.me`).

Queue consumers: `ai-jobs`/`ai-jobs-dlq`/`webhook-jobs`/`webhook-jobs-dlq` →
workflows; `discord-outbox`(+dlq) → responder; `ai-spend-jobs`(+dlq) → spend.

The B-vs-C decision was resolved as **Option C**: `ServiceRegistry` lives on the
standalone `ragbot-registry-worker` and every `script_name` binding points at
it. `DiscordGateway` state is not precious — after any gateway redeploy just
call `/gateway/start` to reconnect.

**The brain→workflows rename cutover (done):** a queue allows one consumer, so
the order was: `POST /gateway/stop` → drain → detach `ragbot-brain-worker` from
`ai-jobs`(+dlq) (`wrangler queues consumer remove`) → delete the brain worker →
deploy the renamed stack in dependency order (connectors → responder → spend →
gateway → workflows+secrets → webhooks+secret → dev-proxy) → migrations/config
push/register-commands → `POST /gateway/start`. The old `BRAIN_SIGNING_KEY`
private half was marooned as a worker secret and died with the worker; a fresh
workflows keypair was minted and `SERVICE_PUBLIC_KEYS` updated everywhere.

**Outstanding:**
- GitHub App secrets ARE set on the broker (from the 1Password item
  "Github App - Rag Apps Gateway": `GITHUB_APP_ID` = the App's client id —
  GitHub accepts it as the App JWT `iss` — plus `GITHUB_APP_PRIVATE_KEY` and
  `GITHUB_WEBHOOK_SECRET`). Still missing: `DISCORD_OAUTH_CLIENT_ID`/`_SECRET`
  for the discord-user 3LO connector — see `CONNECTORS.md`.
- Signing-key JWKs must be the BARE form `{kty,crv,d,x}` — workerd's importKey
  rejects an OKP JWK carrying `alg`, and the failure surfaces as a
  `signing_key_unavailable` denial at runtime, not at deploy.
- Queue hops require `contentType: "bytes"` on send (packages/auth/client.ts);
  the queue default ("json") silently mangles the capnp `Uint8Array` wrapper
  into an index-keyed object the boundary rejects as `body_unparseable`.
- `GATEWAY_SIGNING_KEY`'s private half exists ONLY as a worker secret on
  `ragbot-worker` (never stored in 1Password). If that worker is ever deleted,
  mint a fresh gateway keypair and update `SERVICE_PUBLIC_KEYS` on every
  verifier — same procedure as the workflows rename above.
- `wrangler d1 migrations apply ragbot` must run with
  `CLOUDFLARE_ACCOUNT_ID=314e7e015b5f4429c4e2da1e6ec93271` exported — the API
  token spans multiple accounts and wrangler otherwise picks the wrong one.

## Secrets & config inventory

**Auth for all commands below:**
```sh
export CLOUDFLARE_API_TOKEN=$(op read "op://Services/Cloudflare User API Token/password")
export CLOUDFLARE_ACCOUNT_ID=314e7e015b5f4429c4e2da1e6ec93271
```

**Already in 1Password** (`op://Services/ragbot/<field>`): `ApplicationId`,
`PublicKey`, `bot_token`, `CF_AIG_TOKEN`, `clientid`, `client_secret`.

**Minted and stored in 1Password (`op://Services/ragbot/<field>`) ✅:**
- `GATEWAY_CONTROL_TOKEN` (`openssl rand -hex 32`).
- `WORKFLOWS_SIGNING_KEY`, `WEBHOOKS_SIGNING_KEY`, `DEV_PROXY_SIGNING_KEY` —
  Ed25519 private JWKs. Their **public** halves (not secret) are supplied to
  verifiers via the `SERVICE_PUBLIC_KEYS` var (below); the committed keyring
  stays the test default. `GATEWAY_SIGNING_KEY` is NOT in 1Password — its
  private half lives only as a worker secret (see Outstanding above). Only
  signers hold a private key: gateway, workflows, dev-proxy, webhooks.

**`SERVICE_PUBLIC_KEYS`** — set this as a secret on every VERIFIER worker
(gateway, workflows, responder, spend, connectors). Public keys, safe to
commit/expose — this is the LIVE value as of 2026-07-03:
```json
{"gateway":{"kty":"OKP","crv":"Ed25519","x":"pjPnmzDg8sFiw95aT29EnVQjYmmItFaKY7M7rX03q30"},"workflows":{"kty":"OKP","crv":"Ed25519","x":"hVDFHjvxSCrsYuLFT1ZfOZA1iMWfSJQkJ7q10OeTYiQ"},"dev-proxy":{"kty":"OKP","crv":"Ed25519","x":"-bcFIFR-aRiAU0T9zHQAifPkR15dWOTGNiiUCy5y33U"},"webhooks":{"kty":"OKP","crv":"Ed25519","x":"XGbuyhCDZUowcFGblV9If1OCda2n5m8Wq1gqcVZd6jQ"}}
```

**Config vars to set:** `ALLOWED_GUILD_IDS` = `457689460096630794` (gateway+workflows);
`DEV_PROXY_GUILD` = `457689460096630794` (dev-proxy); `DEV_PROXY_SUBJECT` +
gateway `DEV_PROXY_ALLOWED_SUBJECTS` = `116163000339136518` (operator's Discord
user id); dev-proxy `CF_ACCESS_TEAM_DOMAIN` = `jsmunro.cloudflareaccess.com`,
`CF_ACCESS_AUD` = the Access app AUD tag (from the Access step).

**Per-worker secret matrix** (`wrangler secret put <NAME> -c <config>`, value on stdin):

| Worker (config) | Secrets |
|---|---|
| gateway `workers/public/gateway/wrangler.jsonc` | `DISCORD_PUBLIC_KEY`←PublicKey, `DISCORD_BOT_TOKEN`←bot_token, `GATEWAY_CONTROL_TOKEN`, `GATEWAY_SIGNING_KEY`, `DEV_PROXY_ALLOWED_SUBJECTS` (var, see below) |
| workflows `workers/services/workflows/wrangler.jsonc` | `CF_AIG_TOKEN`, `DISCORD_BOT_TOKEN`←bot_token, `WORKFLOWS_SIGNING_KEY` |
| responder `workers/services/responder/wrangler.jsonc` | `DISCORD_BOT_TOKEN`←bot_token |
| spend `workers/services/spend/wrangler.jsonc` | `CLOUDFLARE_API_TOKEN` |
| dev-proxy `workers/public/dev-proxy/wrangler.jsonc` | `DEV_PROXY_SIGNING_KEY` |
| webhooks `workers/public/webhooks/wrangler.jsonc` | `WEBHOOKS_SIGNING_KEY` |
| connectors `workers/services/connectors/wrangler.jsonc` | `GITHUB_WEBHOOK_SECRET` (webhook ingress; plus the broker's own connector secrets per `CONNECTORS.md`) |

**Config vars** (`[vars]` in each wrangler.jsonc, or `wrangler secret` if sensitive):
- gateway + workflows: `ALLOWED_GUILD_IDS` = the home guild id (the bot's server).
- gateway: `DEV_PROXY_ALLOWED_SUBJECTS` = the Discord user id the dev-proxy may act as.
- dev-proxy: `DEV_PROXY_SUBJECT` = that same Discord user id; `DEV_PROXY_GUILD` =
  home guild id; `CF_ACCESS_TEAM_DOMAIN` = `jsmunro.cloudflareaccess.com`;
  `CF_ACCESS_AUD` = the Access app AUD tag (from step "Access app" below).
- `DISCORD_APPLICATION_ID` is already a plain var in the configs (`1496842…`).

## Option B — ordered in-window cutover

1. **Re-take D1 backup** (see above).
2. **Mint keys/secrets:** generate the control token + 3 signing keypairs; update
   `keyring.ts` public halves; commit. (Secrets are set after each worker exists —
   step 4/5, since `wrangler secret put` needs the script deployed.)
3. **Set config vars** in the five wrangler configs (guild allowlist, dev-proxy
   config). Commit.
4. **Deploy the gateway to `ragbot-worker`** (defines `ServiceRegistry` +
   `DiscordGateway`; this is the cutover of `ragbot.jsmunro.me`):
   `npx wrangler deploy -c workers/public/gateway/wrangler.jsonc`
   then set its secrets, then redeploy once so they're present at boot.
5. **Deploy the services** (now `ragbot-worker` exports `ServiceRegistry`):
   workflows, responder, spend, dev-proxy — `npx wrangler deploy -c <each>`; set each
   worker's secrets; redeploy each once.
6. **D1 migrations:** `npx wrangler d1 migrations apply ragbot --remote`
   (0001 only, non-destructive; the legacy insert shim stays).
7. **Push AI config to KV:** `npm run config:push`.
8. **Start the gateway websocket:**
   `curl -X POST https://ragbot.jsmunro.me/gateway/start -H "Authorization: Bearer $GATEWAY_CONTROL_TOKEN"`
9. **Smoke test** (see below).
10. **Rollback if broken:** `npx wrangler rollback -c workers/public/gateway/wrangler.jsonc`
    (prior version, seconds) and likewise for spend; or `git checkout main` and
    redeploy the two old workers. D1 restore: `wrangler d1 execute ragbot --remote
    --file=backup.sql` or D1 Time Travel.

## Option C — extract the registry first

1. New `workers/services/registry` worker owning `ServiceRegistry` (move the DO
   class + its migration there). Repoint every `SERVICE_REGISTRY` binding's
   `script_name` to `ragbot-registry`; remove the class def + v2 migration from
   the gateway. Commit. `npm run check` + dry-run all six configs.
2. Deploy `ragbot-registry` first, then the rest under `-next` names (duplicate
   configs or use wrangler `--name`), on `ragbot-next.jsmunro.me`. Smoke-test.
3. Cut over `ragbot.jsmunro.me` to the new gateway last.

## Webhook ingress (`webhooks.jsmunro.me`) — operator checklist

The centralised webhook receiver: `ragbot-webhooks-worker` at
`webhooks.jsmunro.me/{provider}/{id}` (see `CONNECTORS.md` "URL conventions").
Deliberately **NOT behind Cloudflare Access** — third parties POST to it; the
provider HMAC (verified in the broker) is the authentication. Order matters:

1. **Create the queues** (before any consumer/producer deploy references them):
   ```sh
   npx wrangler queues create webhook-jobs
   npx wrangler queues create webhook-jobs-dlq
   ```
2. **Mint the webhooks signing keypair:** `tsx scripts/generate-keys.ts webhooks`.
   Store the private JWK in 1Password; add the **public** half to the
   `SERVICE_PUBLIC_KEYS` var on the **verifiers of webhooks-signed hops** —
   the **workflows** and the **connectors broker** (extend the JSON map above with
   a `"webhooks"` entry). Public keys are not secret.
3. **Deploy the broker first** (`ragbot-connectors-worker`) — it is the
   `CONNECTORS` binding target for the webhooks worker — and set its webhook
   secret (referenced by the `github-app` registry entry):
   `wrangler secret put GITHUB_WEBHOOK_SECRET -c workers/services/connectors/wrangler.jsonc`
   (the value comes from the GitHub App's webhook settings; it never leaves the
   broker).
4. **Redeploy the workflows worker** (`npm run deploy:workflows`) — it gains the
   `webhook-jobs`/`webhook-jobs-dlq` consumers and the `CONNECTORS` binding.
5. **Deploy the webhooks worker:** `npm run deploy:webhooks`, then
   `wrangler secret put WEBHOOKS_SIGNING_KEY -c workers/public/webhooks/wrangler.jsonc`
   (the private JWK from step 2), then redeploy once so it is present at boot.
   The `webhooks.jsmunro.me` custom domain is created by the deploy (the zone
   `jsmunro.me` is already in this account — no manual DNS record needed).
6. **Point the provider at it:** the GitHub App's webhook URL is
   `https://webhooks.jsmunro.me/github/github-app` (content type
   `application/json`), with the secret from step 3.
7. **Smoke test:** a GitHub `ping` delivery → 202, and `wrangler tail` on the
   workflows shows a `webhook_event_received` line (connectorId/provider/eventId —
   never the body); a replayed delivery (GitHub "Redeliver") → 200 (dedupe);
   a tampered body → 401. Check `webhook-jobs-dlq` stays empty.

## Dev-proxy Cloudflare Access app + policy

Domain `ragbot-dev.jsmunro.me` (custom domain in the dev-proxy config). Create an
Access **self-hosted application** for that hostname with an **Allow** policy
requiring **both**:
- GitHub org membership = **`jsmunro`** (via the existing GitHub OIDC IdP), AND
- email = **`jack@jsmunro.me`**.

The dev-proxy verifies the Access JWT, so set `CF_ACCESS_TEAM_DOMAIN` =
`jsmunro.cloudflareaccess.com` and `CF_ACCESS_AUD` = the new app's AUD tag on the
dev-proxy worker. Existing Access apps + GitHub IdPs are already configured in
this account (see `access/apps`), so reuse the GitHub identity provider.

API sketch (Allow policy, require-both): `POST /accounts/{acct}/access/apps` with
`{type:"self_hosted", domain:"ragbot-dev.jsmunro.me", ...}` then
`POST /accounts/{acct}/access/apps/{id}/policies` with a `require` block of an
`{github:{name:"jsmunro"}}` rule AND an `{email:{email:"jack@jsmunro.me"}}` rule.

## Smoke tests (after cutover)

- `POST /discord` PING → 200 with `{type:1}` (Discord "endpoint verified").
- `/rag` and `/ragboard` in the guild → D1 writes + leaderboard.
- `/ask` → thread created, AI answer posted.
- Mention the bot → `channel_reply` via workflows → responder posts.
- dev-proxy: load `https://ragbot-dev.jsmunro.me` behind Access, run `/ragboard`
  and `/ask` via the UI or `ragctl` → real result returned synchronously.
- Check DLQs stay empty; check `wrangler tail` on each worker for `*_denied`.
