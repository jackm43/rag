import { bearerToken, logger, type SpanData } from "../../sdk/ts/src";
import { verifyServiceClient } from "./registry";
import type { Env } from "./types";

// The gateway is the platform's trace store: workers export their spans here
// (OTLP/HTTP JSON authenticated with their service credential) and the
// read endpoints answer "what happened, along which path, as whom" — every
// span carries the identity attributes the auth middleware stamped on it.

const RETENTION_SECONDS = 7 * 24 * 3600;

type OtlpAttribute = {
  key?: string;
  value?: { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
};

type OtlpSpan = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttribute[];
  status?: { code?: number; message?: string };
};

type OtlpPayload = {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
};

const KIND_NAMES: Record<number, string> = { 1: "internal", 2: "server", 3: "client" };

const attributeValue = (attribute: OtlpAttribute): unknown => {
  const value = attribute.value ?? {};
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  return null;
};

const attributesObject = (attributes: OtlpAttribute[] | undefined): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const attribute of attributes ?? []) {
    if (attribute.key) {
      result[attribute.key] = attributeValue(attribute);
    }
  }
  return result;
};

const nanosToMs = (nanos: string | undefined): number => Math.floor(Number(nanos ?? 0) / 1_000_000);

export type StoredSpan = {
  service: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: string;
  startMs: number;
  durationMs: number;
  status: string;
  error: string;
  attributes: Record<string, unknown>;
};

const insertSpans = async (env: Env, spans: StoredSpan[]): Promise<void> => {
  if (spans.length === 0) {
    return;
  }
  const statement = env.DB.prepare(
    `INSERT OR REPLACE INTO idp_spans
       (span_id, trace_id, parent_span_id, service, name, kind, start_ms, duration_ms, status, error, attributes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch(
    spans.map((span) =>
      statement.bind(
        span.spanId,
        span.traceId,
        span.parentSpanId,
        span.service,
        span.name,
        span.kind,
        span.startMs,
        span.durationMs,
        span.status,
        span.error,
        JSON.stringify(span.attributes),
      ),
    ),
  );
  // Opportunistic retention sweep; cheap on the start_ms index.
  if (Math.random() < 0.05) {
    const cutoff = Date.now() - RETENTION_SECONDS * 1000;
    await env.DB.prepare("DELETE FROM idp_spans WHERE start_ms < ?").bind(cutoff).run();
  }
};

// localSpanSink is the gateway's own exporter: same store, no HTTP hop.
export const localSpanSink =
  (env: Env) =>
  async (service: string, spans: SpanData[]): Promise<void> => {
    await insertSpans(
      env,
      spans.map((span) => ({
        service,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId ?? "",
        name: span.name,
        kind: span.kind,
        startMs: span.startMs,
        durationMs: span.endMs - span.startMs,
        status: span.error ? "error" : "ok",
        error: span.error ?? "",
        attributes: span.attributes,
      })),
    );
  };

// POST /v1/traces — OTLP/HTTP JSON ingest, authenticated with the calling
// worker's service credential (`Bearer <client_id>:<client_secret>`).
export const handleTraceIngest = async (env: Env, request: Request): Promise<Response> => {
  const token = bearerToken(request.headers) ?? "";
  const separator = token.indexOf(":");
  const application =
    separator > 0
      ? await verifyServiceClient(env, token.slice(0, separator), token.slice(separator + 1))
      : null;
  if (!application) {
    return Response.json({ error: "a service credential is required" }, { status: 401 });
  }

  let payload: OtlpPayload;
  try {
    payload = (await request.json()) as OtlpPayload;
  } catch {
    return Response.json({ error: "invalid OTLP payload" }, { status: 400 });
  }
  const spans: StoredSpan[] = [];
  for (const resourceSpan of payload.resourceSpans ?? []) {
    const resource = attributesObject(resourceSpan.resource?.attributes);
    const service = typeof resource["service.name"] === "string" ? (resource["service.name"] as string) : application;
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        if (!span.traceId || !span.spanId || !span.name) {
          continue;
        }
        const startMs = nanosToMs(span.startTimeUnixNano);
        spans.push({
          service,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId ?? "",
          name: span.name,
          kind: KIND_NAMES[span.kind ?? 1] ?? "internal",
          startMs,
          durationMs: Math.max(0, nanosToMs(span.endTimeUnixNano) - startMs),
          status: span.status?.code === 2 ? "error" : "ok",
          error: span.status?.message ?? "",
          attributes: attributesObject(span.attributes),
        });
      }
    }
  }
  if (spans.length > 500) {
    spans.length = 500;
  }
  await insertSpans(env, spans);
  logger.debug("trace_ingest", { application, spans: spans.length });
  return Response.json({ accepted: spans.length });
};

type SpanRow = {
  span_id: string;
  trace_id: string;
  parent_span_id: string;
  service: string;
  name: string;
  kind: string;
  start_ms: number;
  duration_ms: number;
  status: string;
  error: string;
  attributes: string;
};

const stringAttribute = (attributes: Record<string, unknown>, key: string): string => {
  const value = attributes[key];
  return typeof value === "string" ? value : "";
};

// listTraces — recent traces, newest first: one summary per trace rooted at
// its earliest span (browsers root traces with a client-side traceparent, so
// the first *recorded* span may have a dangling parent), with the actor
// identity the auth middleware recorded.
export const listTraces = async (env: Env, limit: number) => {
  const roots = await env.DB.prepare(
    `SELECT *, MIN(start_ms) AS start_ms FROM idp_spans GROUP BY trace_id ORDER BY start_ms DESC LIMIT ?`,
  )
    .bind(Math.min(Math.max(limit, 1), 100))
    .run<SpanRow>();
  const traceIds = roots.results.map((row) => row.trace_id);
  const counts = new Map<string, number>();
  if (traceIds.length > 0) {
    const placeholders = traceIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT trace_id, COUNT(*) AS spans FROM idp_spans WHERE trace_id IN (${placeholders}) GROUP BY trace_id`,
    )
      .bind(...traceIds)
      .run<{ trace_id: string; spans: number }>();
    for (const row of rows.results) {
      counts.set(row.trace_id, row.spans);
    }
  }
  return roots.results.map((row) => {
    const attributes = JSON.parse(row.attributes || "{}") as Record<string, unknown>;
    return {
      traceId: row.trace_id,
      root: row.name,
      service: row.service,
      actor: stringAttribute(attributes, "actor"),
      actorChain: stringAttribute(attributes, "actor_chain"),
      clientInstance: stringAttribute(attributes, "client_instance"),
      start: new Date(row.start_ms).toISOString(),
      durationMs: BigInt(row.duration_ms),
      status: row.status,
      spans: counts.get(row.trace_id) ?? 1,
    };
  });
};

// streamSpans — spans ingested at or after the cursor (created_at seconds),
// oldest first; the live-tail RPC polls this and dedups on span id.
export const streamSpans = async (env: Env, sinceSeconds: number) => {
  const rows = await env.DB.prepare(
    "SELECT * , created_at FROM idp_spans WHERE created_at >= ? ORDER BY created_at ASC, start_ms ASC LIMIT 200",
  )
    .bind(sinceSeconds)
    .run<SpanRow & { created_at: number }>();
  return rows.results.map((row) => ({
    createdAt: row.created_at,
    traceId: row.trace_id,
    span: {
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      service: row.service,
      name: row.name,
      kind: row.kind,
      start: new Date(row.start_ms).toISOString(),
      durationMs: BigInt(row.duration_ms),
      status: row.status,
      error: row.error,
      attributesJson: row.attributes,
    },
  }));
};

// getTrace — the full request path: every span in the trace in start order,
// with identity attributes intact. Returns null for unknown/invalid ids.
export const getTrace = async (env: Env, traceId: string) => {
  if (!/^[0-9a-f]{32}$/.test(traceId)) {
    return null;
  }
  const rows = await env.DB.prepare(
    "SELECT * FROM idp_spans WHERE trace_id = ? ORDER BY start_ms ASC",
  )
    .bind(traceId)
    .run<SpanRow>();
  if (rows.results.length === 0) {
    return null;
  }
  return rows.results.map((row) => ({
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    service: row.service,
    name: row.name,
    kind: row.kind,
    start: new Date(row.start_ms).toISOString(),
    durationMs: BigInt(row.duration_ms),
    status: row.status,
    error: row.error,
    attributesJson: row.attributes,
  }));
};
