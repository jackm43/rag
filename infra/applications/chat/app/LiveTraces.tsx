import { useEffect, useRef, useState } from "react";

import { TraceService } from "../../idp/server/idp/v1/idp_pb";
import {
  gatewayClient,
  registerChatInstance,
  type ChatInstance,
  type TrustZoneWebAuth,
} from "../../../sdk/web/src";

// Live trace flow: a server-streaming RPC (idp.v1.TraceService/StreamTraces)
// pushes spans as the gateway ingests them. Every browser request roots a
// trace (traceparent minted client-side), so the full flow — proxy hop,
// token exchanges, identity registrations, service calls — renders as one
// waterfall per trace, live.

type LiveSpan = {
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

type LiveTrace = {
  traceId: string;
  expanded: boolean;
  firstSeen: number;
  spans: LiveSpan[];
};

const MAX_TRACES = 20;

const SERVICE_CLASSES = 6;
const serviceClass = (service: string): number => {
  let hash = 0;
  for (const char of service) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash % SERVICE_CLASSES;
};

const shortName = (name: string): string => name.replace(/^rpc \//, "").replace(/^connector /, "tool ");

const spanDepth = (span: LiveSpan, byId: Map<string, LiveSpan>): number => {
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

export function LiveTraces({ auth, signedIn }: { auth: TrustZoneWebAuth; signedIn: boolean }) {
  const [running, setRunning] = useState(false);
  const [traces, setTraces] = useState<LiveTrace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const controller = useRef<AbortController | null>(null);
  // The trace follower is itself a registered client identity (kind
  // "tracing", granted to this web session); its instance rides the stream
  // requests so the boundary crossing is attributed like any other client.
  const tracingIdentity = useRef<ChatInstance | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

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
        setNote("streaming");
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
          let attributes: Record<string, unknown> = {};
          try {
            attributes = JSON.parse(span.attributesJson || "{}") as Record<string, unknown>;
          } catch {
            // Leave empty.
          }
          const live: LiveSpan = {
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
          setTraces((current) => {
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
            return [
              { traceId: message.traceId, expanded: true, firstSeen: Date.now(), spans: [live] },
              ...next,
            ].slice(0, MAX_TRACES);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        setNote(`reconnecting… (${(err as Error).message})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    setRunning(false);
  };

  const stop = () => {
    controller.current?.abort();
    setRunning(false);
    setNote("paused");
  };

  const toggle = (traceId: string) =>
    setTraces((current) =>
      current.map((trace) => (trace.traceId === traceId ? { ...trace, expanded: !trace.expanded } : trace)),
    );

  return (
    <section className="live-traces">
      <div className="live-head">
        <h2>Live request flow</h2>
        <div className="live-controls">
          <span className={`live-dot${running ? " on" : ""}`} />
          <span className="data-path">{note || "watch every hop as it happens"}</span>
          <button onClick={() => { setTraces([]); setSelected(null); }} disabled={traces.length === 0}>
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
        {traces.length === 0 ? (
          <div className="trace-empty">
            {running
              ? "listening — send a message, create a chat, or fetch a data API"
              : "press Watch live, then do something: every request renders here as a waterfall of hops"}
          </div>
        ) : null}
        {traces.map((trace) => {
          const byId = new Map(trace.spans.map((span) => [span.spanId, span]));
          const root = trace.spans[0];
          const traceStart = Math.min(...trace.spans.map((s) => s.startMs));
          const traceEnd = Math.max(...trace.spans.map((s) => s.startMs + s.durationMs));
          const total = Math.max(traceEnd - traceStart, 1);
          const actor = trace.spans.map((s) => s.attributes.actor).find((a) => typeof a === "string") as string | undefined;
          const instance = trace.spans.map((s) => s.attributes.client_instance).find((a) => typeof a === "string") as string | undefined;
          const hasError = trace.spans.some((s) => s.status === "error");
          return (
            <div key={trace.traceId} className={`trace-card${hasError ? " has-error" : ""}`}>
              <button className="trace-card-head" onClick={() => toggle(trace.traceId)}>
                <span className={`trace-status${hasError ? " error" : ""}`} />
                <span className="trace-root">{shortName(root?.name ?? trace.traceId)}</span>
                {actor ? <span className="trace-actor">{actor}</span> : null}
                {instance ? <span className="trace-instance">chat:{instance.slice(0, 8)}</span> : null}
                <span className="trace-meta">
                  {trace.spans.length} hop{trace.spans.length === 1 ? "" : "s"} · {total}ms
                </span>
                <span className="trace-caret">{trace.expanded ? "▾" : "▸"}</span>
              </button>
              {trace.expanded ? (
                <div className="waterfall">
                  {trace.spans.map((span) => {
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
                              <code>{span.kind}</code> · {span.status}
                              {span.error ? <span className="span-error"> — {span.error}</span> : null}
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
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
