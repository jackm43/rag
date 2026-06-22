# 01-security-boundary

Deploy first.

Scope:
- Discord signature freshness and declared body-size guardrails.
- Optional `DISCORD_ALLOWED_GUILD_IDS` allowlist for interactions and gateway messages.
- Optional `RAGBOT_ADMIN_TOKEN` for `/gateway/*`, falling back to `DISCORD_BOT_TOKEN`.
- `deploy.sh` uses the admin token when present.

Verify:
- `npm run check`
- `npm test`

Deploy notes:
- No schema migration required.
- No new Cloudflare binding required.
