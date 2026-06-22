# 02-d1-workspace-memory

Deploy after `01-security-boundary`.

Scope:
- D1 tables for observed Discord messages, assistant memories, and bot-role cache.
- D1-backed Discord bot role cache replaces module-level mutable cache.
- Gateway and queue paths record observed/fetched Discord messages.
- Queue prompt construction can include durable workspace memory and usage context.

Verify:
- `npm run check`
- `npm test`

Deploy notes:
- Apply `schema.sql` before deploying this worktree.
- No new Cloudflare binding required.
