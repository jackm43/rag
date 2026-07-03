# Deploy runbook — `feature/security-architecture`

State of an in-progress production deploy of the new multi-worker architecture,
paused on a decision. Read `STATUS.md` for the architecture; this is the
step-by-step to finish deploying it and cut over the live bot.

**Account:** `jackm` / `314e7e015b5f4429c4e2da1e6ec93271`. **Zone:** `jsmunro.me`
= `0317fdb8f32686c5173f4bcd7c5d1690`.

## Already done (safe, additive — no live impact)

- ✅ **D1 backup** of live `ragbot` (5833b0bb-…): full SQL dump, 644 statements,
  saved to the session scratchpad (`ragbot-d1-backup-<ts>.sql`). Re-take before
  cutover with `wrangler d1 export ragbot --remote --output=backup.sql`.
- ✅ **Queues created:** `discord-outbox`, `discord-outbox-dlq`.
- ✅ **KV namespace created:** `AI_CONFIG` = `2a6dbd4428b64d6982bfe628445c163a`,
  already written into `workers/services/brain/wrangler.jsonc`.

## The decision that gates the rest (B vs C)

Four workers (`brain`, `responder`, `spend`, `dev-proxy`) bind the
`ServiceRegistry` Durable Object with `script_name: "ragbot-worker"`, and the
gateway also owns the stateful `DiscordGateway` DO on that name. Consequence: a
cross-script DO binding requires its target to already export the class, but the
*current* live `ragbot-worker` is the old monolith. **So no service worker can
deploy until the new gateway occupies the `ragbot-worker` name — which is the
cutover.** A true parallel `ragbot-next` stack is therefore not available without
extra work.

- **Option B (recommended for a friends' bot): ordered in-window cutover.**
  Deploy onto the real names in dependency order in one ~10-min window, smoke
  test, roll back fast if broken. A few minutes of possible interaction downtime.
- **Option C: extract `ServiceRegistry` into its own `ragbot-registry` worker**
  (~1 commit), repoint all `script_name` bindings to it, then a real parallel
  `-next` stack becomes possible (zero-downtime staging). More work, cleaner arch.

`DiscordGateway` state is **not** precious — after cutover just call
`/gateway/start` to reconnect; no DO state transfer needed. Cedar has static
bootstrap permits for every hop, so an empty `ServiceRegistry` doesn't break auth.

## Secrets & config inventory

**Auth for all commands below:**
```sh
export CLOUDFLARE_API_TOKEN=$(op read "op://Services/Cloudflare User API Token/password")
export CLOUDFLARE_ACCOUNT_ID=314e7e015b5f4429c4e2da1e6ec93271
```

**Already in 1Password** (`op://Services/ragbot/<field>`): `ApplicationId`,
`PublicKey`, `bot_token`, `CF_AIG_TOKEN`, `clientid`, `client_secret`.

**Missing — must be created during deploy:**
- `GATEWAY_CONTROL_TOKEN` — generate `openssl rand -hex 32`; store in 1P and set as a secret.
- `GATEWAY_SIGNING_KEY`, `BRAIN_SIGNING_KEY`, `DEV_PROXY_SIGNING_KEY` — Ed25519
  private JWKs from `tsx scripts/generate-keys.ts <worker>`. **Each regenerates a
  keypair**, so the printed *public* JWK must replace that worker's entry in
  `packages/identity/keyring.ts` and be committed, and the *private* JWK set as
  the secret. (The keyring currently holds public keys whose private halves were
  not retained, so regenerate all three signers together.)

**Per-worker secret matrix** (`wrangler secret put <NAME> -c <config>`, value on stdin):

| Worker (config) | Secrets |
|---|---|
| gateway `workers/public/gateway/wrangler.jsonc` | `DISCORD_PUBLIC_KEY`←PublicKey, `DISCORD_BOT_TOKEN`←bot_token, `GATEWAY_CONTROL_TOKEN`, `GATEWAY_SIGNING_KEY`, `DEV_PROXY_ALLOWED_SUBJECTS` (var, see below) |
| brain `workers/services/brain/wrangler.jsonc` | `CF_AIG_TOKEN`, `DISCORD_BOT_TOKEN`←bot_token, `BRAIN_SIGNING_KEY` |
| responder `workers/services/responder/wrangler.jsonc` | `DISCORD_BOT_TOKEN`←bot_token |
| spend `workers/services/spend/wrangler.jsonc` | `CLOUDFLARE_API_TOKEN` |
| dev-proxy `workers/public/dev-proxy/wrangler.jsonc` | `DEV_PROXY_SIGNING_KEY` |

**Config vars** (`[vars]` in each wrangler.jsonc, or `wrangler secret` if sensitive):
- gateway + brain: `ALLOWED_GUILD_IDS` = the home guild id (the bot's server).
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
   brain, responder, spend, dev-proxy — `npx wrangler deploy -c <each>`; set each
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
- Mention the bot → `channel_reply` via brain → responder posts.
- dev-proxy: load `https://ragbot-dev.jsmunro.me` behind Access, run `/ragboard`
  and `/ask` via the UI or `ragctl` → real result returned synchronously.
- Check DLQs stay empty; check `wrangler tail` on each worker for `*_denied`.
