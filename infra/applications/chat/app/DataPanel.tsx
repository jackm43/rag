import { useState } from "react";

import { aigateway } from "../../aigateway/web";
import { idp } from "../../idp/web";
import { ragbot } from "../../ragbot/web";
import type { BrowserAuth } from "@platy/web";
import { useAuth } from "@platy/web/react";

type DataApi = {
  label: string;
  application: string;
  path: string;
  param?: { placeholder: string; field?: string };
  run: (auth: BrowserAuth, param: string) => Promise<unknown>;
};

const DATA_APIS: DataApi[] = [
  {
    label: "Rag leaderboard",
    application: "ragbot",
    path: "/ragbot.v1.LeaderboardService/ListTotals",
    run: (auth) => ragbot.leaderboardServiceClient(auth).listTotals({ limit: 20 }),
  },
  {
    label: "Recent AI interactions",
    application: "ragbot",
    path: "/ragbot.v1.InteractionService/ListInteractions",
    run: (auth) => ragbot.interactionServiceClient(auth).listInteractions({ limit: 10 }),
  },
  {
    label: "Bot config",
    application: "ragbot",
    path: "/ragbot.v1.ConfigService/ListConfig",
    run: (auth) => ragbot.configServiceClient(auth).listConfig({}),
  },
  {
    label: "Discord gateway health",
    application: "ragbot",
    path: "/ragbot.v1.GatewayControlService/GetHealth",
    run: (auth) => ragbot.gatewayControlServiceClient(auth).getHealth({}),
  },
  {
    label: "Model catalog",
    application: "aigateway",
    path: "/aigateway.v1.ChatService/ListModels",
    run: (auth) => aigateway.chatServiceClient(auth).listModels({ filter: "", limit: 25 }),
  },
  {
    label: "Recent traces",
    application: "idp",
    path: "/idp.v1.TraceService/ListTraces",
    run: (auth) => idp.traceServiceClient(auth).listTraces({ limit: 20 }),
  },
  {
    label: "Trace detail (request path)",
    application: "idp",
    path: "/idp.v1.TraceService/GetTrace",
    param: { placeholder: "trace id (32 hex chars)", field: "traceId" },
    run: (auth, param) => idp.traceServiceClient(auth).getTrace({ traceId: param }),
  },
  {
    label: "Applications & registrations",
    application: "gateway",
    path: "/api/discovery",
    run: async (auth) => {
      const response = await auth.gatewayGet("/api/discovery");
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text || `request failed (${response.status})`);
      }
      return JSON.parse(text) as unknown;
    },
  },
];

export function DataPanel({ wide = false }: { wide?: boolean }) {
  const { auth, signedIn } = useAuth();
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
      const body = await api.run(auth, param.trim());
      setResult(JSON.stringify(body, null, 2));
      setIsError(false);
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
                {entry.label} · {entry.application}
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
