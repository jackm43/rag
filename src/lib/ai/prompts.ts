// The bundled (Workers-only) prompt text, split out of config.ts so it can be
// loaded lazily via a dynamic import(). Workers' esbuild bundles the `.md`
// text imports below fine (see wrangler.jsonc's Text module rule); Node
// running scripts/register-commands.ts never executes the dynamic-import path
// that reaches this module, so it never needs to load `.md` files as JS.
export { default as discordResponseSystemPrompt } from "./ai-config/discord-response-system-prompt.md";
export { default as askWebSearchSystemPrompt } from "./ai-config/ask-web-search-system-prompt.md";
