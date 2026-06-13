import { useEffect, useState } from "react";
import type { Client } from "@connectrpc/connect";

import type { DiscoveryService } from "../../discovery/server/discovery/v1/discovery_service_pb";
import {
  applicationDetailQuery,
  applicationsListQuery,
  queryDiscovery,
  type ApplicationInfo,
  type SyncState,
} from "../../discovery/web";
import type { BrowserAuth } from "../../../sdk/web/src";

// Application registry view: browse from the discovery GraphQL read model,
// mutate through the gateway's RegistryService (same-origin zone routes), and
// re-sync the read model after changes.

const REGISTER_TEMPLATE = JSON.stringify(
  {
    name: "",
    endpoint: "https://example.jsmunro.me",
    description: "",
    provider: "cloudflare",
    trustZone: "tier2",
    resources: [],
    delegations: [],
    access: { allowedGroups: ["admins"], allowedIdps: ["github"] },
  },
  null,
  2,
);

const formatTime = (seconds: number): string =>
  seconds > 0 ? new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19) : "-";

export function Applications({
  auth,
  signedIn,
  discovery,
}: {
  auth: BrowserAuth;
  signedIn: boolean;
  discovery: Client<typeof DiscoveryService> | null;
}) {
  const [apps, setApps] = useState<ApplicationInfo[]>([]);
  const [detail, setDetail] = useState<ApplicationInfo | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerBody, setRegisterBody] = useState(REGISTER_TEMPLATE);
  const [actionResult, setActionResult] = useState("");

  const load = async () => {
    if (!discovery) {
      setNote("discovery application is not available");
      return;
    }
    setBusy(true);
    setNote("loading");
    try {
      const data = await queryDiscovery<{ applications: ApplicationInfo[]; syncState: SyncState | null }>(
        discovery,
        applicationsListQuery,
      );
      setApps(data.applications ?? []);
      setSync(data.syncState ?? null);
      if (selected) {
        const row = (data.applications ?? []).find((app) => app.name === selected);
        if (!row) {
          setSelected(null);
          setDetail(null);
        }
      }
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
  }, [signedIn, discovery]);

  const runSync = async () => {
    if (!discovery) return;
    setBusy(true);
    try {
      const result = await discovery.sync({});
      setNote(
        `synced ${result.applications} applications, ${result.delegations} delegations, ${result.methods} methods`,
      );
      await load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const callRegistry = async (path: string, body: unknown): Promise<string> => {
    const response = await auth.gatewayCall(path, body);
    const text = await response.text();
    let rendered = text;
    try {
      rendered = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Non-JSON body: show as-is.
    }
    if (!response.ok) {
      throw new Error(rendered || `request failed (${response.status})`);
    }
    return rendered;
  };

  const register = async () => {
    setBusy(true);
    setActionResult("");
    try {
      const body = JSON.parse(registerBody) as Record<string, unknown>;
      const result = await callRegistry("/idp.v1.RegistryService/RegisterApplication", body);
      setActionResult(result);
      setRegisterOpen(false);
      await load();
    } catch (err) {
      setActionResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete application ${name} from the registry?`)) return;
    setBusy(true);
    setActionResult("");
    try {
      const result = await callRegistry("/idp.v1.RegistryService/DeleteApplication", { name });
      setActionResult(result);
      if (selected === name) {
        setSelected(null);
        setDetail(null);
      }
      await load();
    } catch (err) {
      setActionResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!signedIn || !discovery || !selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await queryDiscovery<{ application: ApplicationInfo | null }>(
          discovery,
          applicationDetailQuery,
          { name: selected },
        );
        if (!cancelled) {
          setDetail(data.application ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setNote((err as Error).message);
          setDetail(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, discovery, selected]);

  return (
    <div className="view">
      <div className="view-head">
        <h1>Applications</h1>
        <div className="view-actions">
          <span className="hint">
            {sync
              ? `read model synced ${formatTime(sync.syncedAt)} (${sync.applications} apps)`
              : ""}
          </span>
          <button disabled={!signedIn || busy} onClick={() => void runSync()}>
            Sync read model
          </button>
          <button disabled={!signedIn || busy} onClick={() => void load()}>
            Refresh
          </button>
          <button disabled={!signedIn || busy} onClick={() => setRegisterOpen((open) => !open)}>
            {registerOpen ? "Close register" : "Register application"}
          </button>
        </div>
      </div>
      {note ? <div className="note">{note}</div> : null}

      {registerOpen ? (
        <div className="panel">
          <h2>Register application</h2>
          <p className="hint">
            JSON body for idp.v1.RegistryService/RegisterApplication. A first registration issues a
            service credential; store it via the CLI flow (platy app register) for managed apps.
          </p>
          <textarea
            className="json-editor"
            rows={14}
            value={registerBody}
            spellCheck={false}
            onChange={(e) => setRegisterBody(e.target.value)}
          />
          <div className="view-actions">
            <button disabled={!signedIn || busy} onClick={() => void register()}>
              Submit registration
            </button>
          </div>
        </div>
      ) : null}

      {actionResult ? <pre className="result">{actionResult}</pre> : null}

      <div className="split">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Endpoint</th>
              <th>Trust zone</th>
              <th>Provider</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr
                key={app.name}
                className={app.name === selected ? "selected" : ""}
                onClick={() => setSelected(app.name === selected ? null : app.name)}
              >
                <td className="mono">{app.name}</td>
                <td className="mono">{app.endpoint}</td>
                <td>{app.trustZone || "-"}</td>
                <td>{app.provider || "-"}</td>
                <td>{formatTime(app.updatedAt)}</td>
                <td>
                  <button
                    className="danger small"
                    disabled={!signedIn || busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(app.name);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {apps.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  {signedIn ? "no applications loaded" : "sign in to browse the registry"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {detail ? (
          <div className="panel detail">
            <h2>{detail.name}</h2>
            <dl className="kv">
              <dt>Audience</dt>
              <dd className="mono">{detail.audience}</dd>
              <dt>Endpoint</dt>
              <dd className="mono">{detail.endpoint}</dd>
              <dt>Description</dt>
              <dd>{detail.description || "-"}</dd>
              <dt>Provider</dt>
              <dd>{detail.provider || "-"}</dd>
              <dt>Trust zone</dt>
              <dd>{detail.trustZone || "-"}</dd>
              <dt>Created</dt>
              <dd>{formatTime(detail.createdAt)}</dd>
              <dt>Updated</dt>
              <dd>{formatTime(detail.updatedAt)}</dd>
            </dl>

            <h3>Resources and scopes</h3>
            {!detail.resources || detail.resources.length === 0 ? (
              <p className="hint">no RPC surface (client-only application)</p>
            ) : (
              detail.resources.map((resource) => (
                <div key={resource.name} className="resource">
                  <span className="mono strong">{resource.name}</span>
                  <ul>
                    {resource.methods.map((method) => (
                      <li key={method.name}>
                        <span className="mono">{method.name}</span>
                        <span className="scope">{method.scope}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}

            <h3>Delegations</h3>
            {!detail.delegations || detail.delegations.length === 0 ? (
              <p className="hint">no outbound delegations</p>
            ) : (
              <ul className="delegation-list">
                {detail.delegations.map((delegation) => (
                  <li key={delegation.audience}>
                    <span className="mono strong">{delegation.audience}</span>
                    {delegation.scopes.length > 0 ? (
                      <ul>
                        {delegation.scopes.map((scope) => (
                          <li key={scope} className="scope">
                            {scope}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="hint"> all scopes</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
