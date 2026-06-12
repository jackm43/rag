import { useEffect, useRef, useState } from "react";

import { TraceService } from "../../idp/server/idp/v1/idp_pb";
import {
  gatewayClient,
  registerChatInstance,
  type ChatInstance,
  type TrustZoneWebAuth,
} from "../../../sdk/web/src";

// Trace views over the gateway's TraceService: a recent-trace list with
// per-trace waterfall detail, and a live tail (server-streaming RPC) that
// renders spans as the gateway ingests them. The follower runs under its own
// registered client identity so the boundary crossing is attributed.

type SpanRow = {
  spanId: string;
  parent: string;
  service: string;
  name: string;
  kind: string;
  startMs: number;
  durationMs: number;
  status: string;
  error: string;
  attributes: Record<string, unknown>;
};

type TraceSummary = {
  traceId: string;
  root?: string;
  service?: string;
  actor?: string;
  clientInstance?: string;
  start?: string;
  durationMs?: number | string;
  status?: string;
  spans?: number;
};

type LiveTrace = {
  traceId: string;
  expanded: boolean;
  spans: SpanRow[];
};

const MAX_LIVE_TRACES = 20;

const SERVICE_CLASSES = 6;
const serviceClass = (service: string): number => {
  let hash = 0;
  for (const char of service) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash % SERVICE_CLASSES;
};

const shortName = (name: string): string => name.replace(/^rpc \//, "").replace(/^connector /, "tool ");

const spanDepth = (span: SpanRow, byId: Map<string, SpanRow>): number => {
  let depth = 0;
  let current = span;
  while (current.parent && depth < 6) {
    const parent = byId.get(current.parent);
    if (!parent) {
      // Dangling parent: the browser rooted this trace client-side.
      return depth + 1;
    }
    current = parent;
    depth += 1;
  }
  return depth;
};

const parseSpan = (span: {
  spanId: string;
  parentSpanId: string;
  service: string;
  name: string;
  kind: string;
  start: string;
  durationMs: number | bigint | string;
  status: string;
  error: string;
  attributesJson: string;
}): SpanRow => {
  let attributes: Record<string, unknown> = {};
  try {
    attributes = JSON.parse(span.attributesJson || "{}") as Record<string, unknown>;
  } catch {
    // Leave empty.
  }
  return {
    spanId: span.spanId,
    parent: span.parentSpanId,
    service: span.service,
    name: span.name,
    kind: span.kind,
    startMs: Date.parse(span.start),
    durationMs: Number(span.durationMs),
    status: span.status,
    error: span.error,
    attributes,
  };
};

function Waterfall({ spans }: { spans: SpanRow[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  return (
    <div className="waterfall">
      {spans.map((span) => {
        const depth = spanDepth(span, byId);
        const isSelected = selected === span.spanId;
        return (
          <div key={span.spanId}>
            <button
              className={`waterfall-row${isSelected ? " selected" : ""}`}
              onClick={() => setSelected(isSelected ? null : span.spanId)}
            >
              <span
                className={`waterfall-label svc-c${serviceClass(span.service)}`}
                style={{ paddingLeft: `${depth * 0.9}rem` }}
              >
                <span className="waterfall-service">{span.service}</span>
                {shortName(span.name)}
              </span>
              <span className="waterfall-ms">{span.durationMs}ms</span>
            </button>
            {isSelected ? (
              <div className="span-detail">
                <div>
                  <code>{span.kind}</code> / {span.status}
                  {span.error ? <span className="span-error"> - {span.error}</span> : null}
                </div>
                {Object.keys(span.attributes).length > 0 ? (
                  <pre>{JSON.stringify(span.attributes, null, 2)}</pre>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function Traces({ auth, signedIn }: { auth: TrustZoneWebAuth; signedIn: boolean }) {
  const [summaries, setSummaries] = useState<TraceSummary[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailSpans, setDetailSpans] = useState<SpanRow[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const [running, setRunning] = useState(false);
  const [liveNote, setLiveNote] = useState("");
  const [liveTraces, setLiveTraces] = useState<LiveTrace[]>([]);
  const controller = useRef<AbortController | null>(null);
  const tracingIdentity = useRef<ChatInstance | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const load = async () => {
    setBusy(true);
    setNote("loading");
    try {
      const response = await auth.gatewayCall("/idp.v1.TraceService/ListTraces", { limit: 50 });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text || `request failed (${response.status})`);
      }
      const body = JSON.parse(text) as { traces?: TraceSummary[] };
      setSummaries(body.traces ?? []);
      setNote("");
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (signedIn) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  const openDetail = async (traceId: string) => {
    if (detailId === traceId) {
      setDetailId(null);
      setDetailSpans([]);
      return;
    }
    setDetailId(traceId);
    setDetailSpans([]);
    try {
      const client = gatewayClient(auth, TraceService);
      const result = await client.getTrace({ traceId });
      setDetailSpans(result.spans.map(parseSpan).sort((a, b) => a.startMs - b.startMs));
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const start = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    if (!tracingIdentity.current) {
      try {
        tracingIdentity.current = await registerChatInstance(auth, { kind: "tracing" });
      } catch {
        // Stream anyway; the session identity still authenticates it.
      }
    }
    // The server recycles streams every ~45s and idle connections can be
    // dropped by intermediaries; reconnect on both clean ends and errors
    // until the user pauses.
    while (!abort.signal.aborted) {
      try {
        setLiveNote("streaming");
        const client = gatewayClient(
          auth,
          TraceService,
          tracingIdentity.current ? { headers: tracingIdentity.current.headers } : {},
        );
        for await (const message of client.streamTraces({}, { signal: abort.signal })) {
          const span = message.span;
          if (!span) continue;
          // Don't render the tail's own polling as traffic.
          if (span.name.includes("TraceService/StreamTraces")) continue;
          const live = parseSpan(span);
          setLiveTraces((current) => {
            const next = [...current];
            const index = next.findIndex((trace) => trace.traceId === message.traceId);
            if (index >= 0) {
              const trace = next[index];
              if (trace.spans.some((s) => s.spanId === live.spanId)) return current;
              next[index] = {
                ...trace,
                spans: [...trace.spans, live].sort((a, b) => a.startMs - b.startMs),
              };
              return next;
            }
            return [{ traceId: message.traceId, expanded: true, spans: [live] }, ...next].slice(
              0,
              MAX_LIVE_TRACES,
            );
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        setLiveNote(`reconnecting (${(err as Error).message})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    setRunning(false);
  };

  const stop = () => {
    controller.current?.abort();
    setRunning(false);
    setLiveNote("paused");
  };

  const toggleLive = (traceId: string) =>
    setLiveTraces((current) =>
      current.map((trace) => (trace.traceId === traceId ? { ...trace, expanded: !trace.expanded } : trace)),
    );

  return (
    <div className="view">
      <div className="view-head">
        <h1>Traces</h1>
        <div className="view-actions">
          <button disabled={!signedIn || busy} onClick={() => void load()}>
            Refresh list
          </button>
        </div>
      </div>
      {note ? <div className="note">{note}</div> : null}

      <div className="trace-columns">
        <div className="trace-list-pane">
          <h2>Recent traces</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Root</th>
                <th>Service</th>
                <th>Actor</th>
                <th>Spans</th>
                <th>ms</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((trace) => (
                <tr
                  key={trace.traceId}
                  className={trace.traceId === detailId ? "selected" : ""}
                  onClick={() => void openDetail(trace.traceId)}
                >
                  <td className="mono">{shortName(trace.root ?? trace.traceId)}</td>
                  <td>{trace.service ?? "-"}</td>
                  <td>{trace.actor ?? "-"}</td>
                  <td>{trace.spans ?? "-"}</td>
                  <td>{Number(trace.durationMs ?? 0)}</td>
                  <td className={trace.status === "error" ? "status-error" : ""}>{trace.status ?? "-"}</td>
                </tr>
              ))}
              {summaries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    {signedIn ? "no traces loaded" : "sign in to view traces"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          {detailId ? (
            <div className="panel">
              <h2 className="mono">trace {detailId}</h2>
              {detailSpans.length > 0 ? <Waterfall spans={detailSpans} /> : <p className="hint">loading spans</p>}
            </div>
          ) : null}
        </div>

        <div className="live-traces">
          <div className="live-head">
            <h2>Live stream</h2>
            <div className="live-controls">
              <span className={`live-dot${running ? " on" : ""}`} />
              <span className="data-path">{liveNote || "watch every hop as it happens"}</span>
              <button onClick={() => setLiveTraces([])} disabled={liveTraces.length === 0}>
                Clear
              </button>
              {running ? (
                <button onClick={stop}>Pause</button>
              ) : (
                <button disabled={!signedIn} onClick={() => void start()}>
                  Watch live
                </button>
              )}
            </div>
          </div>

          <div className="trace-feed">
            {liveTraces.length === 0 ? (
              <div className="trace-empty">
                {running
                  ? "listening - run an action in another view and the request renders here"
                  : "press Watch live, then do something: every request renders as a waterfall of hops"}
              </div>
            ) : null}
            {liveTraces.map((trace) => {
              const root = trace.spans[0];
              const traceStart = Math.min(...trace.spans.map((s) => s.startMs));
              const traceEnd = Math.max(...trace.spans.map((s) => s.startMs + s.durationMs));
              const total = Math.max(traceEnd - traceStart, 1);
              const actor = trace.spans.map((s) => s.attributes.actor).find((a) => typeof a === "string") as
                | string
                | undefined;
              const hasError = trace.spans.some((s) => s.status === "error");
              return (
                <div key={trace.traceId} className={`trace-card${hasError ? " has-error" : ""}`}>
                  <button className="trace-card-head" onClick={() => toggleLive(trace.traceId)}>
                    <span className={`trace-status${hasError ? " error" : ""}`} />
                    <span className="trace-root">{shortName(root?.name ?? trace.traceId)}</span>
                    {actor ? <span className="trace-actor">{actor}</span> : null}
                    <span className="trace-meta">
                      {trace.spans.length} hop{trace.spans.length === 1 ? "" : "s"} / {total}ms
                    </span>
                    <span className="trace-caret">{trace.expanded ? "v" : ">"}</span>
                  </button>
                  {trace.expanded ? <Waterfall spans={trace.spans} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
