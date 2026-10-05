// Ragbot's D1 queries. Commands and AI handlers own replies; this module owns durable data.
import { batch, query, type Statement } from "./lib/d1.ts";
import type { Usage } from "./lib/ai.ts";

export type Attribution = { kind: string; userId: string; username: string; channelId: string; messageId: string };
type Total = { rag_count: number };
type Leader = Total & { ragged_user_id: string; ragged_username: string | null };

export async function recordRag(db: D1Database, target: string, name: string | null, invoker: { id: string; username: string }) {
  const now = new Date().toISOString();
  const [ban, , totals] = await batch<{ expires_at: string } & Total>(db, "rag.record", [
    ["SELECT expires_at FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1", invoker.id, now],
    ["INSERT INTO rag_events (ragged_user_id, ragged_username, reported_by_user_id, reported_by_username) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ?)", target, name, invoker.id, invoker.username, invoker.id, now],
    // changes() belongs to the previous INSERT in this transaction; never count a blocked rag.
    ["INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count, updated_at) SELECT ?, ?, 1, CURRENT_TIMESTAMP WHERE changes() > 0 ON CONFLICT(ragged_user_id) DO UPDATE SET rag_count = rag_count + 1, ragged_username = excluded.ragged_username, updated_at = CURRENT_TIMESTAMP RETURNING rag_count", target, name],
  ]);
  return { expiresAt: ban.results[0]?.expires_at, count: totals.results[0]?.rag_count };
}

export async function undoRag(db: D1Database, target: string) {
  const [deleted, totals] = await batch<Total>(db, "rag.undo", [
    ["DELETE FROM rag_events WHERE id = (SELECT id FROM rag_events WHERE ragged_user_id = ? ORDER BY id DESC LIMIT 1) RETURNING id", target],
    // Selecting and deleting the latest event must happen inside the same transaction.
    ["UPDATE rag_totals SET rag_count = max(rag_count - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE ragged_user_id = ? AND changes() > 0 RETURNING rag_count", target],
  ]);
  return deleted.results.length ? totals.results[0]?.rag_count ?? 0 : null;
}

export async function leaderboard(db: D1Database) {
  return (await query<Leader>(db, "rag.leaderboard", "SELECT ragged_user_id, ragged_username, rag_count FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT 10")).results;
}

export function banUser(db: D1Database, target: string, name: string | null, invoker: { id: string; username: string }, expiresAt: string) {
  return query(db, "rag.ban", "INSERT INTO rag_command_bans (banned_user_id, banned_username, banned_by_user_id, banned_by_username, expires_at) VALUES (?, ?, ?, ?, ?)", target, name, invoker.id, invoker.username, expiresAt);
}

export async function unbanUser(db: D1Database, target: string) {
  return (await query(db, "rag.unban", "DELETE FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ?", target, new Date().toISOString())).meta.changes;
}

export type AiInteraction = {
  source: Attribution;
  kind: string;
  prompt: string;
  startedAt: number;
  model: string;
  revision: string | null;
  aiDurationMs: number | null;
  usage: Usage;
  responseText: string | null;
  error: string | null;
};

export function startInteraction(source: Attribution, prompt: string, startedAt = Date.now(), kind = source.kind): AiInteraction {
  return { source, kind, prompt, startedAt, model: "unknown", revision: null, aiDurationMs: null, usage: { prompt: null, completion: null, total: null }, responseText: null, error: null };
}

export async function recordInteractions(db: D1Database, interactions: AiInteraction[]) {
  const finishedAt = Date.now();
  const statements: Statement[] = interactions.map((record) => [
    "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, prompt_tokens, completion_tokens, total_tokens, settings_revision, trigger_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    record.kind, record.source.channelId, record.source.messageId, record.source.userId, record.source.username,
    record.prompt, record.responseText, record.model, record.aiDurationMs, finishedAt - record.startedAt,
    record.error ? "error" : "ok", record.error, record.usage.prompt, record.usage.completion, record.usage.total,
    record.revision, record.source.kind,
  ]);
  try {
    if (statements.length === 1) await query(db, "ai.record", ...statements[0]);
    else await batch(db, "ai.record", statements);
  } catch {
    console.warn("interaction_record_failed");
  }
}

export function promptHistory(db: D1Database, kind: string, before: number | null, search: string) {
  const filters = ["kind = ?"];
  const params: unknown[] = [kind];
  if (before !== null) { filters.push("id < ?"); params.push(before); }
  if (search) { filters.push("instr(lower(prompt), lower(?)) > 0"); params.push(search); }
  return query(db, "ai.history", `SELECT id, kind, prompt, response_text, model, status, requester_username, created_at, settings_revision, trigger_kind, ai_duration_ms, total_duration_ms, prompt_tokens, completion_tokens, total_tokens FROM rag_ai_interactions WHERE ${filters.join(" AND ")} ORDER BY id DESC LIMIT 26`, ...params);
}

export async function interactionsForMessage(db: D1Database, messageId: string) {
  return (await query(db, "ai.for_message", "SELECT * FROM rag_ai_interactions WHERE message_id = ? ORDER BY id", messageId)).results;
}
