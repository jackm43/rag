import { errorMessage, logger } from "../logger";
import type { Env } from "../../env";
import type { AiThread } from "../contracts";

type AiThreadRow = {
  thread_id: string;
  parent_channel_id: string | null;
  source_message_id: string | null;
  requester_user_id: string | null;
  requester_username: string | null;
  initial_prompt: string;
  title: string;
};

const toAiThread = (row: AiThreadRow): AiThread => ({
  threadId: row.thread_id,
  parentChannelId: row.parent_channel_id ?? undefined,
  sourceMessageId: row.source_message_id ?? undefined,
  requesterUserId: row.requester_user_id ?? undefined,
  requesterUsername: row.requester_username ?? undefined,
  initialPrompt: row.initial_prompt,
  title: row.title,
});

const getAiThread = async (env: Env, threadId: string): Promise<AiThread | null> => {
  const row = await env.DB.prepare(
    "SELECT thread_id, parent_channel_id, source_message_id, requester_user_id, requester_username, initial_prompt, title FROM rag_ai_threads WHERE thread_id = ?",
  )
    .bind(threadId)
    .first<AiThreadRow>();
  return row ? toAiThread(row) : null;
};

export const findAiThread = async (env: Env, threadId: string): Promise<AiThread | null> =>
  getAiThread(env, threadId).catch((error) => {
    logger.warn("ai_thread_lookup_failed", { error: errorMessage(error) });
    return null;
  });

export const recordAiThread = async (env: Env, thread: AiThread) => {
  await env.DB.prepare(
    "INSERT INTO rag_ai_threads (thread_id, parent_channel_id, source_message_id, requester_user_id, requester_username, initial_prompt, title, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(thread_id) DO UPDATE SET parent_channel_id = excluded.parent_channel_id, source_message_id = excluded.source_message_id, requester_user_id = excluded.requester_user_id, requester_username = excluded.requester_username, initial_prompt = excluded.initial_prompt, title = excluded.title, updated_at = CURRENT_TIMESTAMP",
  )
    .bind(
      thread.threadId,
      thread.parentChannelId ?? null,
      thread.sourceMessageId ?? null,
      thread.requesterUserId ?? null,
      thread.requesterUsername ?? null,
      thread.initialPrompt,
      thread.title,
    )
    .run();
};
