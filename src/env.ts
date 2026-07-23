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

  // Secrets
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  GATEWAY_CONTROL_TOKEN: string;
  CF_AIG_TOKEN: string;
}
