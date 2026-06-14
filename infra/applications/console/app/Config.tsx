import { useEffect, useMemo, useState } from "react";

import { createPlatformWebClient, type ConfigEntry } from "@platy/web";
import { useAuth } from "@platy/web/react";

export function Config() {
  const { auth, signedIn } = useAuth();
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [health, setHealth] = useState("");

  const configClient = useMemo(() => createPlatformWebClient(auth, "ragbot").configServiceClient(), [auth]);
  const gatewayClient = useMemo(() => createPlatformWebClient(auth, "ragbot").gatewayControlServiceClient(), [auth]);

  const load = async () => {
    setBusy(true);
    setNote("loading");
    try {
      const result = await configClient.listConfig({});
      setEntries(result.entries ?? []);
      setNote("");
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadHealth = async () => {
    try {
      const result = await gatewayClient.getHealth({});
      setHealth(JSON.stringify(result, null, 2));
    } catch (err) {
      setHealth((err as Error).message);
    }
  };

  useEffect(() => {
    if (signedIn) {
      void load();
      void loadHealth();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  const save = async (key: string) => {
    setBusy(true);
    try {
      await configClient.updateConfig({ key, value: draft });
      setEditing(null);
      await load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (key: string) => {
    setBusy(true);
    try {
      await configClient.resetConfig({ key });
      setEditing(null);
      await load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="view">
      <div className="view-head">
        <h1>Ragbot config</h1>
        <div className="view-actions">
          <button disabled={!signedIn || busy} onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>
      {note ? <div className="note">{note}</div> : null}

      <div className="split">
        <table className="data-table config-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th>Default</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.key} className={entry.overridden ? "overridden" : ""}>
                <td className="mono">{entry.key}</td>
                <td className="mono value-cell">
                  {editing === entry.key ? (
                    <input
                      autoFocus
                      value={draft}
                      disabled={busy}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void save(entry.key);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      spellCheck={false}
                    />
                  ) : (
                    entry.value ?? ""
                  )}
                </td>
                <td className="mono muted">{entry.defaultValue ?? ""}</td>
                <td className="actions-cell">
                  {editing === entry.key ? (
                    <>
                      <button className="small" disabled={busy} onClick={() => void save(entry.key)}>
                        Save
                      </button>
                      <button className="small ghost" disabled={busy} onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="small"
                        disabled={!signedIn || busy}
                        onClick={() => {
                          setEditing(entry.key);
                          setDraft(entry.value ?? "");
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="small ghost"
                        disabled={!signedIn || busy || !entry.overridden}
                        onClick={() => void reset(entry.key)}
                      >
                        Reset
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty">
                  {signedIn ? "no config loaded" : "sign in to manage config"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <div className="panel detail">
          <div className="view-head">
            <h2>Discord gateway health</h2>
            <button className="small" disabled={!signedIn} onClick={() => void loadHealth()}>
              Refresh
            </button>
          </div>
          <pre className="result">{health || "-"}</pre>
        </div>
      </div>
    </div>
  );
}
