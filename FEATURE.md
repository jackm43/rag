# 03-assistant-tools

Deploy after `02-d1-workspace-memory`.

Scope:
- D1 tool audit table.
- Server-side web search tool with Brave when `BRAVE_SEARCH_API_KEY` is present and DuckDuckGo fallback otherwise.
- Server-side ragboard lookup tool.
- Explicit memory save tool for prompts like `remember that ...`.
- Tool results are injected into the model prompt as trusted server context.

Verify:
- `npm run check`
- `npm test`

Deploy notes:
- Apply `schema.sql` before deploying this worktree.
- `BRAVE_SEARCH_API_KEY` is optional; the no-key fallback still works.
