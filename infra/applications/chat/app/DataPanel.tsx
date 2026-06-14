import { useState } from "react";

import { createPlatformWebClient, type BrowserAuth } from "@platy/web";
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
    path: "/platform/ragbot/v1/leaderboard/totals",
    run: (auth) => createPlatformWebClient(auth, "ragbot").leaderboardServiceClient().listTotals({ limit: 20 }),
  },
  {
    label: "Recent AI interactions",
    application: "ragbot",
    path: "/platform/ragbot/v1/interactions",
    run: (auth) => createPlatformWebClient(auth, "ragbot").interactionServiceClient().listInteractions({ limit: 10 }),
  },
  {
    label: "Bot config",
    application: "ragbot",
    path: "/platform/ragbot/v1/configurations",
    run: (auth) => createPlatformWebClient(auth, "ragbot").configServiceClient().listConfig({}),
  },
  {
    label: "Discord gateway health",
    application: "ragbot",
    path: "/platform/ragbot/v1/gateway/health",
    run: (auth) => createPlatformWebClient(auth, "ragbot").gatewayControlServiceClient().getHealth({}),
  },
  {
    label: "Model catalog",
    application: "aigateway",
    path: "/platform/aigateway/v1/models",
    run: (auth) => createPlatformWebClient(auth, "aigateway").chatServiceClient().listModels({ filter: "", limit: 25 }),
  },
  {
    label: "Recent traces",
    application: "idp",
    path: "/platform/traces/v1/traces",
    run: (auth) => createPlatformWebClient(auth, "idp").traceServiceClient().listTraces({ limit: 20 }),
  },
  {
    label: "Trace detail (request path)",
    application: "idp",
    path: "/platform/traces/v1/traces/{traceId}",
    param: { placeholder: "trace id (32 hex chars)", field: "traceId" },
    run: (auth, param) => createPlatformWebClient(auth, "idp").traceServiceClient().getTrace({ traceId: param }),
  },
  {
    label: "Applications & registrations",
    application: "idp",
    path: "/platform/gateway/v1/discovery",
    run: (auth) => createPlatformWebClient(auth, "idp").discoveryServiceClient().discover({}),
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
    setResult("");
    try {
      const data = await api.run(auth, param.trim());
      setResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setIsError(true);
      setResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!signedIn) {
    return null;
  }

  return (
    <section className={`data-panel${wide ? " wide" : ""}`}>
      <h2>Data &amp; platform APIs</h2>
      <p className="hint">
        Same-origin proxy calls through this page&apos;s worker (session + DPoP at the edge, chained audience token per target).
      </p>
      <label>
        API
        <select value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
          {DATA_APIS.map((entry, index) => (
            <option key={entry.label} value={index}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      {api.param ? (
        <label>
          {api.param.placeholder}
          <input value={param} onChange={(event) => setParam(event.target.value)} />
        </label>
      ) : null}
      <div className="data-path">
        <code>{api.application}</code>
        <code>{api.path}</code>
      </div>
      <button type="button" disabled={busy} onClick={() => void run()}>
        {busy ? "Running..." : "Run"}
      </button>
      {result ? (
        <pre className={isError ? "error" : undefined}>{result}</pre>
      ) : null}
    </section>
  );
}
