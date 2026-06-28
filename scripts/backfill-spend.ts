import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ApiLog = Record<string, unknown>;

type InteractionRow = {
  id: number;
  kind: string;
  channel_id: string | null;
  message_id: string | null;
  requester_user_id: string | null;
  requester_username: string | null;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  created_at: string;
};

type SpendEvent = {
  sourceId: string;
  kind: string;
  requesterUserId: string;
  requesterUsername: string | null;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostMicros: number | null;
};

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const accountId = process.env.CF_ACCOUNT_ID ?? args.get("account-id") ?? "314e7e015b5f4429c4e2da1e6ec93271";
const gatewayId = process.env.CF_AIG_GATEWAY_ID ?? args.get("gateway-id") ?? "platy";
const databaseName = args.get("database") ?? "ragbot";
const perPage = Math.min(50, Number(args.get("per-page") ?? 50));
const maxPages = Number(args.get("max-pages") ?? 20);
const dryRun = args.get("dry-run") === "true";
const apply = args.get("apply") === "true";
const windowMs = Number(args.get("match-window-minutes") ?? 10) * 60 * 1000;

const wranglerAuthToken = () => {
  try {
    const output = execFileSync("npx", ["wrangler", "auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^[A-Za-z0-9._-]{30,}$/.test(line)) ?? null;
  } catch {
    return null;
  }
};

const apiToken =
  process.env.CLOUDFLARE_API_TOKEN ??
  process.env.CF_API_TOKEN ??
  wranglerAuthToken() ??
  process.env.CF_AIG_TOKEN;

if (!apiToken) {
  throw new Error("CLOUDFLARE_API_TOKEN, CF_API_TOKEN, or a Wrangler auth session is required");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberFrom = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const stringFrom = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const sqlString = (value: string | null) =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

const sqlNumber = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "NULL" : String(Math.trunc(value));

const parseMetadata = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const logIdFrom = (log: ApiLog) =>
  stringFrom(log.id) ??
  stringFrom(log.log_id) ??
  stringFrom(log.event_id) ??
  stringFrom(log.request_id) ??
  stringFrom(log.cf_aig_log_id);

const logTimestampFrom = (log: ApiLog) =>
  stringFrom(log.created_at) ??
  stringFrom(log.timestamp) ??
  stringFrom(log.started_at) ??
  stringFrom(log.datetime);

const parseD1Timestamp = (value: string) => {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(value)) {
    return Date.parse(value);
  }
  return Date.parse(`${value.replace(" ", "T")}Z`);
};

const logModelFrom = (log: ApiLog) =>
  stringFrom(log.model) ?? stringFrom(log.model_name) ?? stringFrom(log.ai_model);

const costMicrosFrom = (log: ApiLog) => {
  const cost = numberFrom(log.cost);
  return cost === null ? null : Math.round(cost * 1_000_000);
};

const usageFrom = (log: ApiLog) => {
  const promptTokens = numberFrom(log.tokens_in ?? log.prompt_tokens ?? log.input_tokens);
  const completionTokens = numberFrom(log.tokens_out ?? log.completion_tokens ?? log.output_tokens);
  const totalTokens = numberFrom(log.total_tokens) ??
    (promptTokens === null && completionTokens === null ? null : (promptTokens ?? 0) + (completionTokens ?? 0));
  return { promptTokens, completionTokens, totalTokens };
};

const runWranglerJson = (command: string) => {
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", databaseName, "--remote", "--json", "--command", command],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(output);
};

const loadInteractions = (): InteractionRow[] => {
  const payload = runWranglerJson(
    "SELECT id, kind, channel_id, message_id, requester_user_id, requester_username, model, prompt_tokens, completion_tokens, total_tokens, created_at FROM rag_ai_interactions WHERE requester_user_id IS NOT NULL ORDER BY created_at ASC",
  );
  const first = Array.isArray(payload) ? payload[0] : payload;
  const results = isRecord(first) && Array.isArray(first.results) ? first.results : [];
  return Array.isArray(results) ? results as InteractionRow[] : [];
};

const fetchLogs = async (): Promise<ApiLog[]> => {
  const logs: ApiLog[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`AI Gateway logs request failed (${response.status}): ${JSON.stringify(payload)}`);
    }
    const result = isRecord(payload) && Array.isArray(payload.result) ? payload.result : [];
    logs.push(...result.filter(isRecord));
    const resultInfo = isRecord(payload) && isRecord(payload.result_info) ? payload.result_info : {};
    const totalPages = numberFrom(resultInfo.total_pages);
    if (result.length < perPage || (totalPages !== null && page >= totalPages)) {
      break;
    }
  }
  return logs;
};

const scoreMatch = (log: ApiLog, interaction: InteractionRow) => {
  const { promptTokens, completionTokens, totalTokens } = usageFrom(log);
  const model = logModelFrom(log);
  const timestamp = logTimestampFrom(log);
  const logTime = timestamp ? Date.parse(timestamp) : Number.NaN;
  const rowTime = parseD1Timestamp(interaction.created_at);
  if (!Number.isFinite(logTime) || !Number.isFinite(rowTime) || Math.abs(logTime - rowTime) > windowMs) {
    return -1;
  }

  let score = 0;
  if (model && (model === interaction.model || model.endsWith(interaction.model) || interaction.model.endsWith(model))) {
    score += 4;
  }
  if (promptTokens !== null && promptTokens === interaction.prompt_tokens) {
    score += 4;
  }
  if (completionTokens !== null && completionTokens === interaction.completion_tokens) {
    score += 4;
  }
  if (totalTokens !== null && totalTokens === interaction.total_tokens) {
    score += 2;
  }
  score += Math.max(0, 2 - Math.abs(logTime - rowTime) / 60_000);
  return score;
};

const buildEvents = (logs: ApiLog[], interactions: InteractionRow[]) => {
  const usedInteractionIds = new Set<number>();
  const events: SpendEvent[] = [];
  let metadataMatches = 0;
  let correlatedMatches = 0;
  let unmatched = 0;

  for (const log of logs) {
    const id = logIdFrom(log);
    const model = logModelFrom(log);
    if (!id || !model) {
      unmatched += 1;
      continue;
    }

    const metadata = parseMetadata(log.metadata);
    const metadataUserId = stringFrom(metadata.discord_user_id);
    const metadataKind = stringFrom(metadata.ragbot_kind);
    const metadataRequestId = stringFrom(metadata.ragbot_request_id);
    const { promptTokens, completionTokens, totalTokens } = usageFrom(log);
    if (metadataUserId) {
      events.push({
        sourceId: metadataRequestId ?? `aig:${id}`,
        kind: metadataKind ?? "ai_gateway_log",
        requesterUserId: metadataUserId,
        requesterUsername: null,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostMicros: costMicrosFrom(log),
      });
      metadataMatches += 1;
      continue;
    }

    let best: { row: InteractionRow; score: number } | null = null;
    for (const row of interactions) {
      if (usedInteractionIds.has(row.id)) {
        continue;
      }
      const score = scoreMatch(log, row);
      if (score > (best?.score ?? -1)) {
        best = { row, score };
      }
    }

    if (!best || best.score < 8 || !best.row.requester_user_id) {
      unmatched += 1;
      continue;
    }

    usedInteractionIds.add(best.row.id);
    events.push({
      sourceId: `aig:${id}`,
      kind: best.row.kind,
      requesterUserId: best.row.requester_user_id,
      requesterUsername: best.row.requester_username,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostMicros: costMicrosFrom(log),
    });
    correlatedMatches += 1;
  }

  return { events, metadataMatches, correlatedMatches, unmatched };
};

const buildSql = (events: SpendEvent[]) => {
  const statements = events.map((event) => `
INSERT INTO rag_ai_spend_events (source_id, kind, requester_user_id, requester_username, model, prompt_tokens, completion_tokens, total_tokens, unit_count, estimated_cost_micros, status, updated_at)
VALUES (${sqlString(event.sourceId)}, ${sqlString(event.kind)}, ${sqlString(event.requesterUserId)}, ${sqlString(event.requesterUsername)}, ${sqlString(event.model)}, ${sqlNumber(event.promptTokens)}, ${sqlNumber(event.completionTokens)}, ${sqlNumber(event.totalTokens)}, 0, ${sqlNumber(event.estimatedCostMicros)}, 'aggregated', CURRENT_TIMESTAMP)
ON CONFLICT(source_id) DO UPDATE SET requester_user_id = excluded.requester_user_id, requester_username = COALESCE(excluded.requester_username, rag_ai_spend_events.requester_username), model = excluded.model, prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens, total_tokens = excluded.total_tokens, estimated_cost_micros = excluded.estimated_cost_micros, status = 'aggregated', updated_at = CURRENT_TIMESTAMP;`);

  statements.push(`
INSERT INTO rag_ai_spend_totals (requester_user_id, requester_username, estimated_cost_micros, event_count, updated_at)
SELECT requester_user_id, MAX(requester_username), COALESCE(SUM(estimated_cost_micros), 0), COUNT(*), CURRENT_TIMESTAMP
FROM rag_ai_spend_events
WHERE requester_user_id IS NOT NULL AND status = 'aggregated'
GROUP BY requester_user_id
ON CONFLICT(requester_user_id) DO UPDATE SET requester_username = COALESCE(excluded.requester_username, rag_ai_spend_totals.requester_username), estimated_cost_micros = excluded.estimated_cost_micros, event_count = excluded.event_count, updated_at = CURRENT_TIMESTAMP;`);

  return statements.join("\n");
};

const main = async () => {
  const [logs, interactions] = await Promise.all([fetchLogs(), Promise.resolve(loadInteractions())]);
  const { events, metadataMatches, correlatedMatches, unmatched } = buildEvents(logs, interactions);
  console.log(JSON.stringify({
    logs: logs.length,
    interactions: interactions.length,
    events: events.length,
    metadataMatches,
    correlatedMatches,
    unmatched,
    dryRun,
    apply,
  }, null, 2));

  const sql = buildSql(events);
  const sqlPath = join(mkdtempSync(join(tmpdir(), "rag-spend-backfill-")), "backfill.sql");
  writeFileSync(sqlPath, sql);
  console.log(`SQL written to ${sqlPath}`);

  if (apply && !dryRun && events.length > 0) {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", databaseName, "--remote", "--file", sqlPath],
      { stdio: "inherit" },
    );
  }
};

await main();
