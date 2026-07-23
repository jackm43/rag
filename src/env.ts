export interface Env {
  // Bindings
  DB: D1Database;
  AI_CONFIG: KVNamespace;
  AI: Ai;
  DISCORD_GATEWAY: DurableObjectNamespace;

  // Vars
  DISCORD_APPLICATION_ID: string;
  ALLOWED_GUILD_IDS: string;
  CF_ACCOUNT_ID: string;
  CF_AIG_GATEWAY_ID: string;
  // Optional AI usage-guard tuning vars (fall back to code defaults when unset).
  AI_BURST_LIMIT_PER_MINUTE?: string;
  AI_GLOBAL_DAILY_BUDGET_USD?: string;

  // Secrets
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  GATEWAY_CONTROL_TOKEN: string;
  CF_AIG_TOKEN: string;
  // Cloudflare account API token used by the spend reconciliation sweep to read
  // AI Gateway logs (distinct from CF_AIG_TOKEN, which authenticates model calls).
  CLOUDFLARE_API_TOKEN: string;
}
