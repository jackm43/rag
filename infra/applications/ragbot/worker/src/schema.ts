import { errorMessage, logger } from "@platy/sdk";

import type { Env } from "./types";

let cachedEnsure: Promise<void> | null = null;
let cachedDb: D1Database | null = null;

const ensureColumn = async (env: Env, table: string, column: string, definition: string) => {
  const existing = await env.DB.prepare(`PRAGMA table_info(${table})`).run<{ name: string }>();
  const names = new Set((existing.results ?? []).map((row) => row.name));
  if (names.has(column)) {
    return;
  }
  await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
};

export const ensureRagbotSchema = (env: Env): Promise<void> => {
  if (cachedEnsure && cachedDb === env.DB) {
    return cachedEnsure;
  }
  cachedDb = env.DB;
  cachedEnsure = (async () => {
    try {
      await ensureColumn(env, "rag_ai_interactions", "prompt_tokens", "INTEGER");
      await ensureColumn(env, "rag_ai_interactions", "completion_tokens", "INTEGER");
      await ensureColumn(env, "rag_ai_interactions", "total_tokens", "INTEGER");
    } catch (error) {
      logger.warn("ragbot_schema_ensure_failed", { error: errorMessage(error) });
      throw error;
    }
  })();
  return cachedEnsure;
};
