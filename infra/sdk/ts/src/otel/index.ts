import { AsyncLocalStorage } from "node:async_hooks";

import { errorMessage, logger } from "../logger";
import {
  currentSpanContext,
  formatTraceparent,
  runWithActiveSpan,
  setActiveSpanStore,
} from "./context";

export { annotateSpan, currentSpanContext, formatTraceparent, traceHeaders } from "./context";

type RequestHandler = (request: Request, ctx?: ExecutionContext) => Promise<Response | null>;

// Minimal OpenTelemetry tracing for workers: W3C traceparent propagation,
// spans with attributes/status, and OTLP/HTTP JSON export. Every span is also
// emitted as a structured log line, so Workers Logs gives duration/error
// monitoring even before an OTLP backend is configured; export is best-effort
// and disabled when no endpoint is set.

export type SpanContext = { traceId: string; spanId: string };

export type SpanKind = "internal" | "server" | "client";

type AttributeValue = string | number | boolean;

export type SpanData = {
  name: string;
  kind: SpanKind;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, AttributeValue>;
  error?: string;
};

export type Span = {
  readonly context: SpanContext;
  setAttribute(key: string, value: AttributeValue): void;
  recordError(error: unknown): void;
  // Drops the span (no log, no export); for requests that turn out not to be
  // ours to trace.
  discard(): void;
  end(): void;
};

setActiveSpanStore(new AsyncLocalStorage<Span>());

export type SpanOptions = {
  kind?: SpanKind;
  parent?: SpanContext | null;
  attributes?: Record<string, AttributeValue>;
};

export type Tracer = {
  startSpan(name: string, options?: SpanOptions): Span;
  // Runs fn with the span as the active context (outbound helpers pick it up
  // for propagation), recording errors and ending the span on completion.
  span<T>(name: string, options: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T>;
  flush(): Promise<void>;
};

export type TracerConfig = {
  service: string;
  // OTLP/HTTP base URL; spans POST to `${endpoint}/v1/traces`. Unset disables
  // export (spans still log).
  endpoint?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  // Custom export sink; when set it replaces the OTLP HTTP export entirely
  // (the gateway writes its own spans straight to storage, workers export
  // through their gateway service binding).
  exporter?: (service: string, spans: SpanData[]) => Promise<void>;
};

const hex = (bytes: number): string => {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
};

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export const parseTraceparent = (header: string | null): SpanContext | null => {
  const match = header ? TRACEPARENT.exec(header.trim()) : null;
  return match ? { traceId: match[1], spanId: match[2] } : null;
};

const KIND_CODES: Record<SpanKind, number> = { internal: 1, server: 2, client: 3 };

const otlpValue = (value: AttributeValue) => {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
};

const otlpAttributes = (attributes: Record<string, AttributeValue>) =>
  Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));

const otlpPayload = (service: string, spans: SpanData[]) => ({
  resourceSpans: [
    {
      resource: { attributes: otlpAttributes({ "service.name": service }) },
      scopeSpans: [
        {
          scope: { name: "platy-sdk" },
          spans: spans.map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId ?? "",
            name: span.name,
            kind: KIND_CODES[span.kind],
            startTimeUnixNano: `${span.startMs}000000`,
            endTimeUnixNano: `${span.endMs}000000`,
            attributes: otlpAttributes(span.attributes),
            status: span.error ? { code: 2, message: span.error } : { code: 1 },
          })),
        },
      ],
    },
  ],
});

export const createTracer = (config: TracerConfig): Tracer => {
  const transport = config.fetch ?? globalThis.fetch.bind(globalThis);
  const finished: SpanData[] = [];

  const startSpan = (name: string, options: SpanOptions = {}): Span => {
    const parent = options.parent === undefined ? currentSpanContext() : options.parent;
    const data: SpanData = {
      name,
      kind: options.kind ?? "internal",
      traceId: parent?.traceId ?? hex(16),
      spanId: hex(8),
      parentSpanId: parent?.spanId,
      startMs: Date.now(),
      endMs: 0,
      attributes: { ...options.attributes },
    };
    let done = false;
    let discarded = false;
    return {
      context: { traceId: data.traceId, spanId: data.spanId },
      setAttribute: (key, value) => {
        data.attributes[key] = value;
      },
      recordError: (error) => {
        data.error = errorMessage(error);
      },
      discard: () => {
        discarded = true;
      },
      end: () => {
        if (done || discarded) {
          done = true;
          return;
        }
        done = true;
        data.endMs = Date.now();
        finished.push(data);
        logger.info("span", {
          service: config.service,
          span: data.name,
          kind: data.kind,
          trace_id: data.traceId,
          span_id: data.spanId,
          parent_span_id: data.parentSpanId,
          duration_ms: data.endMs - data.startMs,
          status: data.error ? "error" : "ok",
          error: data.error,
          ...data.attributes,
        });
      },
    };
  };

  return {
    startSpan,
    span: async (name, options, fn) => {
      const span = startSpan(name, options);
      try {
        return await runWithActiveSpan(span, () => fn(span));
      } catch (error) {
        span.recordError(error);
        throw error;
      } finally {
        span.end();
      }
    },
    flush: async () => {
      if ((!config.exporter && !config.endpoint) || finished.length === 0) {
        finished.length = 0;
        return;
      }
      const spans = finished.splice(0, finished.length);
      try {
        if (config.exporter) {
          await config.exporter(config.service, spans);
          return;
        }
        await transport(`${config.endpoint!.replace(/\/$/, "")}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/json", ...config.headers },
          body: JSON.stringify(otlpPayload(config.service, spans)),
        });
      } catch (error) {
        logger.warn("otlp_export_failed", { error: errorMessage(error) });
      }
    },
  };
};

export type OtelEnv = {
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  // Comma-separated key=value pairs, matching the OTEL convention.
  OTEL_EXPORTER_OTLP_HEADERS?: string;
};

const parseHeaderList = (raw: string | undefined): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const index = pair.indexOf("=");
    if (index > 0) {
      headers[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }
  }
  return headers;
};

export const tracerFromEnv = (
  env: OtelEnv,
  service: string,
  options: Pick<TracerConfig, "exporter" | "fetch"> = {},
): Tracer =>
  createTracer({
    service: env.OTEL_SERVICE_NAME || service,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: parseHeaderList(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...options,
  });

// gatewayTraceExporter sends spans to the auth gateway's trace store
// (`POST /v1/traces`, OTLP JSON), authenticated with this worker's service
// credential and routed over the gateway service binding.
export const gatewayTraceExporter = (options: {
  gatewayUrl: string;
  credential: { clientId: string; clientSecret: string };
  fetch?: typeof fetch;
}): ((service: string, spans: SpanData[]) => Promise<void>) => {
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const url = `${options.gatewayUrl.replace(/\/$/, "")}/v1/traces`;
  return async (service, spans) => {
    await transport(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.credential.clientId}:${options.credential.clientSecret}`,
      },
      body: JSON.stringify(otlpPayload(service, spans)),
    });
  };
};

// traceRpc wraps a worker's RPC handler in a server span: trace context comes
// from the caller's traceparent (or starts a new trace), the span records
// method/path/status, and the export flush rides ctx.waitUntil. Requests the
// handler does not own (null response) leave no span behind.
export const traceRpc =
  (tracer: Tracer, rpc: RequestHandler) =>
  async (request: Request, ctx?: ExecutionContext): Promise<Response | null> => {
    const url = new URL(request.url);
    const parent = parseTraceparent(request.headers.get("traceparent"));
    const span = tracer.startSpan(`rpc ${url.pathname}`, {
      kind: "server",
      parent,
      attributes: { "http.method": request.method, "url.path": url.pathname },
    });
    try {
      const response = await runWithActiveSpan(span, () => rpc(request));
      if (response === null) {
        span.discard();
        return null;
      }
      span.setAttribute("http.status_code", response.status);
      if (response.status >= 500) {
        span.recordError(`http ${response.status}`);
      }
      return response;
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
      if (typeof ctx?.waitUntil === "function") {
        ctx.waitUntil(tracer.flush());
      } else {
        void tracer.flush();
      }
    }
  };
