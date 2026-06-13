import { useState } from "react";

import type { BrowserAuth } from "@platy/web";

// Read-only data + platform APIs callable from the page. Connect entries go
// same-origin through the chat BFF (session token + DPoP proof; the worker
// chains the user's identity to the target audience). Gateway entries hit the
// auth gateway's HTTP API (same-origin zone routes) with the session token —
// traces include the identity attributes stamped on every span.
type DataApi = {
  label: string;
  kind: "connect" | "gateway" | "gateway-rpc";
  application?: string;
  path: string;
  body?: Record<string, unknown>;
  param?: { placeholder: string; field?: string };
};

const DATA_APIS: DataApi[] = [
  {
    label: "Rag leaderboard",
    kind: "connect",
    application: "ragbot",
    path: "/ragbot.v1.LeaderboardService/ListTotals",
    body: { limit: 20 },
  },
  {
    label: "Recent AI interactions",
    kind: "connect",
    application: "ragbot",
    path: "/ragbot.v1.InteractionService/ListInteractions",
    body: { limit: 10 },
  },
  {
    label: "Bot config",
    kind: "connect",
    application: "ragbot",
    path: "/ragbot.v1.ConfigService/ListConfig",
    body: {},
  },
  {
    label: "Discord gateway health",
    kind: "connect",
    application: "ragbot",
    path: "/ragbot.v1.GatewayControlService/GetHealth",
    body: {},
  },
  {
    label: "Model catalog",
    kind: "connect",
    application: "aigateway",
    path: "/aigateway.v1.ChatService/ListModels",
    body: { filter: "", limit: 25 },
  },
  {
    label: "Recent traces",
    kind: "gateway-rpc",
    path: "/idp.v1.TraceService/ListTraces",
    body: { limit: 20 },
  },
  {
    label: "Trace detail (request path)",
    kind: "gateway-rpc",
    path: "/idp.v1.TraceService/GetTrace",
    body: {},
    param: { placeholder: "trace id (32 hex chars)", field: "traceId" },
  },
  {
    label: "Applications & registrations",
    kind: "gateway",
    path: "/api/discovery",
  },
];

export function DataPanel({
  auth,
  signedIn,
  wide = false,
}: {
  auth: BrowserAuth;
  signedIn: boolean;
  wide?: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const [param, setParam] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [isError, setIsError] = useState(false);

  const api = DATA_APIS[selected];

  const run = async () => {
    setBusy(true);
    setIsError(false);
    setResult("…");
    try {
      let response: Response;
      if (api.kind === "gateway") {
        const path = api.param ? api.path.replace("{id}", encodeURIComponent(param.trim())) : api.path;
        response = await auth.gatewayGet(path);
      } else if (api.kind === "gateway-rpc") {
        const body = { ...(api.body ?? {}) };
        if (api.param?.field) {
          body[api.param.field] = param.trim();
        }
        response = await auth.gatewayCall(api.path, body);
      } else {
        response = await auth.call(api.application!, api.path, api.body ?? {});
      }
      const text = await response.text();
      let rendered = text;
      try {
        rendered = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Non-JSON body: show as-is.
      }
      setIsError(!response.ok);
      setResult(rendered || `(empty response, status ${response.status})`);
    } catch (err) {
      setIsError(true);
      setResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className={`data-panel${wide ? " wide" : ""}`}>
      <div className="data-left">
      <h2>Data & platform APIs</h2>
      <div className="data-controls">
        <select
          value={selected}
          disabled={!signedIn || busy}
          onChange={(e) => {
            setSelected(Number(e.target.value));
            setParam("");
          }}
        >
          {DATA_APIS.map((entry, index) => (
            <option key={entry.path} value={index}>
              {entry.label} · {entry.application ?? "gateway"}
            </option>
          ))}
        </select>
        <button onClick={() => void run()} disabled={!signedIn || busy || (!!api.param && !param.trim())}>
          {busy ? "…" : "Fetch"}
        </button>
      </div>
      {api.param ? (
        <input
          className="data-param"
          value={param}
          placeholder={api.param.placeholder}
          disabled={!signedIn || busy}
          onChange={(e) => setParam(e.target.value)}
          spellCheck={false}
        />
      ) : null}
      <span className="data-path">{api.path}</span>
      </div>
      <pre className={`data-result${isError ? " error" : ""}`}>
        {result || (signedIn ? "Select an API and fetch." : "Sign in to query data APIs.")}
      </pre>
    </aside>
  );
}
