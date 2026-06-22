# 04-assistant-workflows

Deploy after `03-assistant-tools`.

Scope:
- Cloudflare Workflow binding `ASSISTANT_WORKFLOW`.
- `AssistantWorkflow` durable web-search/research workflow.
- Queue handoff for explicit prompts such as `deep search ...` or `run a workflow ...`.
- D1 workflow audit table.

Verify:
- `npm run check`
- `npm test`

Deploy notes:
- Apply `schema.sql` before deploying this worktree.
- Deploy creates/uses the Workflow binding from `wrangler.jsonc`.
- Run `npx wrangler types worker-configuration.d.ts` after binding changes.
