import { errorMessage, logger } from "./logger";
import { extractExplicitMemory, storeExplicitMemory } from "./memory";
import type { AiChannelJob, Env } from "./types";
import { isRecord } from "./validation";

const MAX_TOOL_RESULT_LENGTH = 1800;
const WEB_SEARCH_RESULT_LIMIT = 5;

type SearchResult = {
  title: string;
  url?: string;
  snippet: string;
};

export type AssistantToolResult = {
  name: string;
  status: "ok" | "error";
  content: string;
};

type RagboardRow = {
  ragged_user_id: string;
  ragged_username: string | null;
  rag_count: number;
};

const truncate = (value: string, maxLength: number) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const shouldUseWebSearch = (prompt: string) =>
  /\b(web|internet|search|look up|lookup|browse|google|latest|current|today|news|source|sources)\b/i.test(prompt);

export const shouldStartAssistantWorkflow = (prompt: string) =>
  /\b(deep search|research this|run a workflow|background search|long search)\b/i.test(prompt);

const shouldLookupRagboard = (prompt: string) =>
  /\b(ragboard|leaderboard|rag stats|rag count|most ragged|top rags)\b/i.test(prompt);

const searchQueryFromPrompt = (prompt: string) =>
  truncate(
    normalizeWhitespace(
      prompt
        .replace(/\b(?:please )?(?:web )?(?:search|look up|lookup|browse|google)\b/gi, "")
        .replace(/\b(?:the )?(?:latest|current|today'?s?)\b/gi, "")
        .replace(/\s+/g, " "),
    ),
    180,
  ) || truncate(normalizeWhitespace(prompt), 180);

const resultPreview = (content: string) => truncate(content.replace(/\s+/g, " "), 500);

const recordToolRun = async (
  env: Env,
  job: AiChannelJob,
  toolName: string,
  status: "ok" | "error",
  query: string | null,
  startedAt: number,
  content: string | null,
  errorText: string | null,
) => {
  try {
    await env.DB.prepare(
      "INSERT INTO assistant_tool_runs (tool_name, status, channel_id, message_id, requester_user_id, query, result_preview, duration_ms, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        toolName,
        status,
        job.channelId,
        job.messageId ?? null,
        job.requesterUserId ?? null,
        query,
        content ? resultPreview(content) : null,
        Date.now() - startedAt,
        errorText,
      )
      .run();
  } catch (error) {
    logger.debug("assistant_tool_record_failed", { toolName, error: errorMessage(error) });
  }
};

const withToolAudit = async (
  env: Env,
  job: AiChannelJob,
  name: string,
  query: string | null,
  run: () => Promise<string>,
): Promise<AssistantToolResult> => {
  const startedAt = Date.now();
  try {
    const content = truncate(await run(), MAX_TOOL_RESULT_LENGTH);
    await recordToolRun(env, job, name, "ok", query, startedAt, content, null);
    return { name, status: "ok", content };
  } catch (error) {
    const message = errorMessage(error);
    await recordToolRun(env, job, name, "error", query, startedAt, null, message);
    return { name, status: "error", content: `${name} failed: ${message}` };
  }
};

const parseDuckDuckGoTopics = (topics: unknown, results: SearchResult[]) => {
  if (!Array.isArray(topics)) {
    return;
  }

  for (const topic of topics) {
    if (results.length >= WEB_SEARCH_RESULT_LIMIT) {
      return;
    }
    if (!isRecord(topic)) {
      continue;
    }
    if (typeof topic.Text === "string") {
      results.push({
        title: typeof topic.FirstURL === "string" ? topic.FirstURL : "DuckDuckGo result",
        url: typeof topic.FirstURL === "string" ? topic.FirstURL : undefined,
        snippet: topic.Text,
      });
      continue;
    }
    parseDuckDuckGoTopics(topic.Topics, results);
  }
};

export const webSearch = async (env: Env, query: string): Promise<SearchResult[]> => {
  const braveKey = env.BRAVE_SEARCH_API_KEY?.trim() || env.WEB_SEARCH_API_KEY?.trim();
  if (braveKey) {
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${WEB_SEARCH_RESULT_LIMIT}`,
      {
        headers: {
          accept: "application/json",
          "x-subscription-token": braveKey,
        },
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Brave Search failed (${response.status})`);
    }
    const web = isRecord(payload) && isRecord(payload.web) ? payload.web : null;
    const rawResults = web && Array.isArray(web.results) ? web.results : [];
    return rawResults
      .filter(isRecord)
      .slice(0, WEB_SEARCH_RESULT_LIMIT)
      .map((item) => ({
        title: typeof item.title === "string" ? item.title : "Search result",
        url: typeof item.url === "string" ? item.url : undefined,
        snippet: typeof item.description === "string" ? item.description : "",
      }))
      .filter((item) => item.snippet || item.url);
  }

  const response = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    { headers: { accept: "application/json" } },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload)) {
    throw new Error(`DuckDuckGo search failed (${response.status})`);
  }

  const results: SearchResult[] = [];
  if (typeof payload.AbstractText === "string" && payload.AbstractText.trim()) {
    results.push({
      title: typeof payload.Heading === "string" && payload.Heading ? payload.Heading : query,
      url: typeof payload.AbstractURL === "string" ? payload.AbstractURL : undefined,
      snippet: payload.AbstractText,
    });
  }
  parseDuckDuckGoTopics(payload.RelatedTopics, results);
  return results.slice(0, WEB_SEARCH_RESULT_LIMIT);
};

const formatSearchResults = (query: string, results: SearchResult[]) => {
  if (results.length === 0) {
    return `No web search results found for "${query}".`;
  }
  const lines = [`Web search results for "${query}":`];
  results.forEach((result, index) => {
    const url = result.url ? ` (${result.url})` : "";
    lines.push(`${index + 1}. ${result.title}${url}: ${result.snippet}`);
  });
  return lines.join("\n");
};

const runWebSearchTool = async (env: Env, prompt: string) => {
  const query = searchQueryFromPrompt(prompt);
  const results = await webSearch(env, query);
  return formatSearchResults(query, results);
};

const runRagboardTool = async (env: Env) => {
  const result = await env.DB.prepare(
    "SELECT ragged_user_id, ragged_username, rag_count FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT 10",
  ).run<RagboardRow>();

  const rows = result.results ?? [];
  if (rows.length === 0) {
    return "Ragboard is empty.";
  }
  return [
    "Current ragboard:",
    ...rows.map((row, index) => {
      const name = row.ragged_username || row.ragged_user_id;
      return `${index + 1}. ${name}: ${row.rag_count}`;
    }),
  ].join("\n");
};

const runMemoryTool = async (env: Env, job: AiChannelJob, prompt: string) => {
  const memory = extractExplicitMemory(prompt);
  if (!memory) {
    return null;
  }
  await storeExplicitMemory(env, job, memory);
  return `Saved ${memory.scope} memory "${memory.label}": ${memory.value}`;
};

export const runAssistantTools = async (
  env: Env,
  job: AiChannelJob,
  prompt: string,
): Promise<AssistantToolResult[]> => {
  const toolRuns: Array<Promise<AssistantToolResult | null>> = [];

  if (shouldUseWebSearch(prompt)) {
    toolRuns.push(
      withToolAudit(env, job, "web_search", searchQueryFromPrompt(prompt), () =>
        runWebSearchTool(env, prompt),
      ),
    );
  }

  if (shouldLookupRagboard(prompt)) {
    toolRuns.push(withToolAudit(env, job, "ragboard_lookup", null, () => runRagboardTool(env)));
  }

  if (extractExplicitMemory(prompt)) {
    toolRuns.push(withToolAudit(env, job, "remember", null, () => runMemoryTool(env, job, prompt).then((result) => result ?? "No memory saved.")));
  }

  const results = await Promise.all(toolRuns);
  return results.filter((result): result is AssistantToolResult => result !== null);
};

export const formatToolResultsForPrompt = (results: AssistantToolResult[]) => {
  if (results.length === 0) {
    return null;
  }

  return [
    "Server-side tool results available to answer the user:",
    ...results.map((result) => `<tool name="${result.name}" status="${result.status}">\n${result.content}\n</tool>`),
  ].join("\n\n");
};
