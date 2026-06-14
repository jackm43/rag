import { useEffect, useMemo, useState } from "react";

import { createPlatformWebClient } from "@platy/web";
import { useAuth } from "@platy/web/react";

type WorkerInfo = { name?: string; modifiedOn?: string };

export function Deploy() {
  const { auth, signedIn } = useAuth();
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [raw, setRaw] = useState("");

  const deployClient = useMemo(() => createPlatformWebClient(auth, "deploy").deployServiceClient(), [auth]);

  const load = async () => {
    setBusy(true);
    setNote("loading");
    try {
      const result = await deployClient.listWorkers({});
      setWorkers(result.workers ?? []);
      setRaw(JSON.stringify(result, null, 2));
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

  const detail = workers.find((worker) => worker.name === selected) ?? null;

  return (
    <div className="view">
      <div className="view-head">
        <h1>Deploy</h1>
        <div className="view-actions">
          <button disabled={!signedIn || busy} onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>
      <p className="hint">
        Bundle building and upload happen outside this console (wrangler deploy or your CI pipeline).
        This view lists live Cloudflare worker scripts via deploy.DeployService.ListWorkers.
      </p>
      {note ? <div className="note">{note}</div> : null}

      <div className="split">
        <table className="data-table">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Modified</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((worker) => (
              <tr
                key={worker.name}
                className={worker.name === selected ? "selected" : ""}
                onClick={() => setSelected(worker.name === selected ? null : (worker.name ?? null))}
              >
                <td className="mono">{worker.name}</td>
                <td>{worker.modifiedOn ? worker.modifiedOn.replace("T", " ").slice(0, 19) : "-"}</td>
              </tr>
            ))}
            {workers.length === 0 ? (
              <tr>
                <td colSpan={2} className="empty">
                  {signedIn ? "no workers listed" : "sign in to list workers"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {detail ? (
          <div className="panel detail">
            <h2>{detail.name}</h2>
            <dl className="kv">
              <dt>Modified</dt>
              <dd>{detail.modifiedOn ?? "-"}</dd>
            </dl>
            <p className="hint">
              Redeploy with wrangler deploy for {detail.name}. The deploy service holds no
              provider credential; it chains the caller's identity to the cloudflare application.
            </p>
          </div>
        ) : raw ? (
          <pre className="result">{raw}</pre>
        ) : null}
      </div>
    </div>
  );
}
