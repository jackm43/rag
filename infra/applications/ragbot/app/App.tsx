import { useEffect, useMemo, useRef, useState } from "react";

import {
  createPlatformWebClient,
  type ConfigEntry,
  type ModelInfo,
  type RagInteraction,
  type TraceSpan,
  type TraceSummary,
} from "@platy/web";
import { useAuth } from "@platy/web/react";

type View =
  | "leaderboard"
  | "interactions"
  | "models"
  | "config"
  | "database"
  | "gateway"
  | "observability"
  | "chat";

type JsonRecord = Record<string, unknown>;
type Interaction = RagInteraction;
type RagTotal = { userId: string; username: string; ragCount: number; updatedAt: string };

type TraceRow = {
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
  spans: TraceRow[];
};

type TableSchema = {
  name: string;
  sql: string;
  columns: Array<{
    cid: number;
    name: string;
    type: string;
    notNull: boolean;
    defaultValue: string;
    primaryKey: boolean;
  }>;
};

const VIEWS: Array<{ id: View; label: string }> = [
  { id: "leaderboard", label: "Leaderboard" },
  { id: "interactions", label: "Interactions" },
  { id: "models", label: "Models" },
  { id: "config", label: "Config" },
  { id: "database", label: "Database" },
  { id: "observability", label: "Observability" },
  { id: "gateway", label: "Gateway" },
  { id: "chat", label: "Chat" },
];

const MODEL_KEYS = {
  ai_response_model: "Response",
  ai_mention_model: "Mention",
  ai_roast_model: "Roast",
} as const;

const PROMPT_KEYS = new Set(["ai_system_prompt", "ai_roast_system_prompt"]);
const DEFAULT_SQL = `SELECT id, kind, requester_username, model, status, created_at
FROM rag_ai_interactions
ORDER BY id DESC
LIMIT 25`;
const MAX_LIVE_TRACES = 20;

const jsonStringify = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return jsonStringify(value);
  return String(value);
};

const clampLimit = (value: number, fallback = 20): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), 100);
};

const toGatewayModelId = (value: string): string =>
  value.startsWith("@cf/") ? `workers-ai/${value}` : value;

const costForInteraction = (
  interaction: Interaction,
  modelById: Map<string, ModelInfo>,
): number | null => {
  const model = modelById.get(interaction.model) ?? modelById.get(toGatewayModelId(interaction.model));
  if (!model) return null;
  return (
    Number(interaction.promptTokens) * model.costIn +
    Number(interaction.completionTokens) * model.costOut
  );
};

const formatUsd = (value: number | null): string =>
  value === null ? "-" : `$${value.toFixed(value < 0.01 ? 5 : 3)}`;

const modelCostLabel = (model: ModelInfo): string =>
  model.costIn > 0 || model.costOut > 0
    ? `$${(model.costIn * 1e6).toFixed(2)}/M in · $${(model.costOut * 1e6).toFixed(2)}/M out`
    : "Included";

const parseTrace = (span: TraceSpan): TraceRow => {
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

const shortTraceName = (name: string): string =>
  name.replace(/^rpc \//, "").replace(/^connector /, "tool ");

const serviceClass = (service: string): number => {
  let hash = 0;
  for (const char of service) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash % 6;
};

const spanDepth = (span: TraceRow, byId: Map<string, TraceRow>): number => {
  let depth = 0;
  let current = span;
  while (current.parent && depth < 8) {
    const parent = byId.get(current.parent);
    if (!parent) return depth + 1;
    current = parent;
    depth += 1;
  }
  return depth;
};

const ResultBlock = ({ title, value }: { title: string; value: unknown }) => (
  <section className="section">
    <div className="section-head">
      <h2>{title}</h2>
    </div>
    <pre className="result">{typeof value === "string" ? value : jsonStringify(value)}</pre>
  </section>
);

const LeaderboardView = () => {
  const { auth, signedIn } = useAuth();
  const client = useMemo(() => createPlatformWebClient(auth, "ragbot").leaderboardServiceClient(), [auth]);
  const [limit, setLimit] = useState(25);
  const [totals, setTotals] = useState<RagTotal[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = async () => {
    setBusy(true);
    setNote("");
    try {
      const result = await client.listTotals({ limit: clampLimit(limit, 25) });
      setTotals(result.totals ?? []);
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

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Leaderboard</h1>
          <p className="hint">/platform/ragbot/v1/leaderboard/totals</p>
        </div>
        <div className="view-actions">
          <label className="inline-field">
            <span>Limit</span>
            <input
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </label>
          <button disabled={!signedIn || busy} onClick={() => void load()}>
            {busy ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>
      {note ? <div className="note error">{note}</div> : null}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>User ID</th>
              <th>Rag Count</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {totals.length > 0 ? (
              totals.map((entry) => (
                <tr key={`${entry.userId}-${entry.updatedAt}`}>
                  <td>{entry.username}</td>
                  <td className="mono">{entry.userId}</td>
                  <td>{entry.ragCount.toString()}</td>
                  <td className="mono">{entry.updatedAt}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="empty-state" colSpan={4}>
                  {signedIn ? "No leaderboard data yet." : "Sign in to load leaderboard data."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const InteractionsView = () => {
  const { auth, signedIn } = useAuth();
  const interactionClient = useMemo(() => createPlatformWebClient(auth, "ragbot").interactionServiceClient(), [auth]);
  const modelClient = useMemo(() => createPlatformWebClient(auth, "aigateway").chatServiceClient(), [auth]);
  const [limit, setLimit] = useState(25);
  const [items, setItems] = useState<Interaction[]>([]);
  const [modelById, setModelById] = useState<Map<string, ModelInfo>>(new Map());
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = async () => {
    setBusy(true);
    setNote("");
    try {
      const [interactionResult, modelResult] = await Promise.all([
        interactionClient.listInteractions({ limit: clampLimit(limit, 25) }),
        modelClient.listModels({ filter: "", limit: 500 }),
      ]);
      setItems(interactionResult.interactions ?? []);
      setModelById(new Map((modelResult.models ?? []).map((model: ModelInfo) => [model.id, model])));
      if (!selectedId && interactionResult.interactions?.[0]) {
        setSelectedId(interactionResult.interactions[0].id.toString());
      }
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

  const selected = items.find((item) => item.id.toString() === selectedId) ?? null;
  const selectedCost = selected ? costForInteraction(selected, modelById) : null;

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Interactions</h1>
          <p className="hint">Stored ragbot interactions with token usage and estimated request cost.</p>
        </div>
        <div className="view-actions">
          <label className="inline-field">
            <span>Limit</span>
            <input
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </label>
          <button disabled={!signedIn || busy} onClick={() => void load()}>
            {busy ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>
      {note ? <div className="note error">{note}</div> : null}
      <div className="content-grid wide">
        <section className="section">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>User</th>
                  <th>Model</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {items.length > 0 ? (
                  items.map((item) => {
                    const selectedRow = item.id.toString() === selectedId;
                    return (
                      <tr
                        key={item.id.toString()}
                        className={selectedRow ? "selected" : ""}
                        onClick={() => setSelectedId(item.id.toString())}
                      >
                        <td className="mono">{item.id.toString()}</td>
                        <td>{item.requesterUsername}</td>
                        <td className="mono">{item.model}</td>
                        <td>{item.totalTokens.toString()}</td>
                        <td>{formatUsd(costForInteraction(item, modelById))}</td>
                        <td>{item.status}</td>
                        <td className="mono">{item.createdAt}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="empty-state" colSpan={7}>
                      {signedIn ? "No interactions yet." : "Sign in to load interactions."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section detail-pane">
          <div className="section-head">
            <h2>Selected interaction</h2>
          </div>
          {selected ? (
            <>
              <dl className="kv-list">
                <div>
                  <dt>ID</dt>
                  <dd className="mono">{selected.id.toString()}</dd>
                </div>
                <div>
                  <dt>Kind</dt>
                  <dd>{selected.kind}</dd>
                </div>
                <div>
                  <dt>User</dt>
                  <dd>{selected.requesterUsername}</dd>
                </div>
                <div>
                  <dt>Channel</dt>
                  <dd className="mono">{selected.channelId}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd className="mono">{selected.model}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{selected.status}</dd>
                </div>
                <div>
                  <dt>Prompt Tokens</dt>
                  <dd>{selected.promptTokens.toString()}</dd>
                </div>
                <div>
                  <dt>Completion Tokens</dt>
                  <dd>{selected.completionTokens.toString()}</dd>
                </div>
                <div>
                  <dt>Total Tokens</dt>
                  <dd>{selected.totalTokens.toString()}</dd>
                </div>
                <div>
                  <dt>Estimated Cost</dt>
                  <dd>{formatUsd(selectedCost)}</dd>
                </div>
                <div>
                  <dt>AI Time</dt>
                  <dd>{selected.aiDurationMs.toString()} ms</dd>
                </div>
                <div>
                  <dt>Total Time</dt>
                  <dd>{selected.totalDurationMs.toString()} ms</dd>
                </div>
              </dl>
              <h3>Prompt</h3>
              <pre className="result">{selected.prompt || "-"}</pre>
              <h3>Response</h3>
              <pre className="result">{selected.responseText || "-"}</pre>
              {selected.errorMessage ? (
                <>
                  <h3>Error</h3>
                  <pre className="result error-block">{selected.errorMessage}</pre>
                </>
              ) : null}
            </>
          ) : (
            <div className="empty-state">Select a row to inspect it.</div>
          )}
        </section>
      </div>
    </div>
  );
};

const ModelsView = () => {
  const { auth, signedIn } = useAuth();
  const configClient = useMemo(() => createPlatformWebClient(auth, "ragbot").configServiceClient(), [auth]);
  const modelClient = useMemo(() => createPlatformWebClient(auth, "aigateway").chatServiceClient(), [auth]);
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const selected = useMemo(
    () => Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
    [entries],
  );

  const load = async () => {
    setBusy(true);
    setNote("");
    try {
      const [configResult, modelResult] = await Promise.all([
        configClient.listConfig({}),
        modelClient.listModels({ filter: "", limit: 500 }),
      ]);
      setEntries(configResult.entries ?? []);
      setModels((modelResult.models ?? []).sort((a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id)));
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

  const selectModel = async (key: keyof typeof MODEL_KEYS, model: string) => {
    setBusy(true);
    setNote("");
    try {
      await configClient.updateConfig({ key, value: model });
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
        <div>
          <h1>Models</h1>
          <p className="hint">Choose the configured model for response, mention, and roast flows.</p>
        </div>
        <div className="view-actions">
          <button disabled={!signedIn || busy} onClick={() => void load()}>
            {busy ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>
      {note ? <div className="note error">{note}</div> : null}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Provider</th>
              <th>Pricing</th>
              {Object.values(MODEL_KEYS).map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {models.length > 0 ? (
              models.map((model) => (
                <tr key={model.id}>
                  <td className="mono">{model.id}</td>
                  <td>{model.provider}</td>
                  <td>{modelCostLabel(model)}</td>
                  {(Object.keys(MODEL_KEYS) as Array<keyof typeof MODEL_KEYS>).map((key) => {
                    const isCurrent =
                      toGatewayModelId(selected[key] ?? "") === model.id || (selected[key] ?? "") === model.id;
                    return (
                      <td key={key}>
                        <button
                          className={`small ${isCurrent ? "muted-button" : "ghost"}`}
                          disabled={!signedIn || busy || isCurrent}
                          onClick={() => void selectModel(key, model.id)}
                        >
                          {isCurrent ? "Selected" : "Use"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))
            ) : (
              <tr>
                <td className="empty-state" colSpan={6}>
                  {signedIn ? "No models loaded." : "Sign in to load models."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const PromptModal = ({
  entry,
  busy,
  onClose,
  onSave,
}: {
  entry: ConfigEntry;
  busy: boolean;
  onClose: () => void;
  onSave: (next: string) => Promise<void>;
}) => {
  const [value, setValue] = useState(entry.value ?? "");
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
        <div className="section-head">
          <div>
            <h2>{entry.key}</h2>
            <p className="hint">Large prompt editor</p>
          </div>
          <button className="ghost" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
        {!entry.overridden ? (
          <div className="note">This prompt is currently using the default configuration.</div>
        ) : null}
        <textarea
          className="editor modal-editor"
          rows={18}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
        />
        <div className="view-actions">
          <button className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button disabled={busy} onClick={() => void onSave(value)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

const ConfigView = () => {
  const { auth, signedIn } = useAuth();
  const client = useMemo(() => createPlatformWebClient(auth, "ragbot").configServiceClient(), [auth]);
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [editing, setEditing] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [promptEntry, setPromptEntry] = useState<ConfigEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = async () => {
    setBusy(true);
    setNote("");
    try {
      const result = await client.listConfig({});
      setEntries(
        (result.entries ?? []).filter((entry: ConfigEntry) => !(entry.key in MODEL_KEYS)).sort((a: ConfigEntry, b: ConfigEntry) => a.key.localeCompare(b.key)),
      );
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

  const save = async (key: string, value: string) => {
    setBusy(true);
    setNote("");
    try {
      await client.updateConfig({ key, value });
      setEditing("");
      setPromptEntry(null);
      await load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (key: string) => {
    setBusy(true);
    setNote("");
    try {
      await client.resetConfig({ key });
      setEditing("");
      setPromptEntry(null);
      await load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const prompts = entries.filter((entry) => PROMPT_KEYS.has(entry.key));
  const scalarEntries = entries.filter((entry) => !PROMPT_KEYS.has(entry.key));

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Config</h1>
          <p className="hint">Prompt editing and non-model runtime settings.</p>
        </div>
        <div className="view-actions">
          <button disabled={!signedIn || busy} onClick={() => void load()}>
            {busy ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>
      {note ? <div className="note error">{note}</div> : null}

      <section className="section">
        <div className="section-head">
          <h2>System Prompts</h2>
        </div>
        <div className="prompt-grid">
          {prompts.map((entry) => (
            <article key={entry.key} className="prompt-card">
              <div className="prompt-card-head">
                <div>
                  <h3>{entry.key}</h3>
                  <p className="hint">{entry.overridden ? "Custom prompt active" : "Using default prompt"}</p>
                </div>
                <div className="view-actions">
                  <button
                    className="ghost"
                    disabled={!signedIn || busy}
                    onClick={() => setPromptEntry(entry)}
                  >
                    Edit
                  </button>
                  <button
                    className="ghost"
                    disabled={!signedIn || busy || !entry.overridden}
                    onClick={() => void reset(entry.key)}
                  >
                    Reset
                  </button>
                </div>
              </div>
              <pre className="result compact-result">{entry.value}</pre>
              {!entry.overridden ? (
                <div className="note">Default prompt is active.</div>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Other Settings</h2>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Default</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scalarEntries.map((entry) => {
                const isEditing = editing === entry.key;
                return (
                  <tr key={entry.key}>
                    <td className="mono">{entry.key}</td>
                    <td className="mono wide-cell">
                      {isEditing ? (
                        <input
                          value={draft}
                          disabled={busy}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void save(entry.key, draft);
                            if (e.key === "Escape") setEditing("");
                          }}
                          spellCheck={false}
                        />
                      ) : (
                        entry.value
                      )}
                    </td>
                    <td className="mono">{entry.defaultValue}</td>
                    <td className="actions-cell">
                      {isEditing ? (
                        <>
                          <button disabled={busy} onClick={() => void save(entry.key, draft)}>
                            Save
                          </button>
                          <button className="ghost" disabled={busy} onClick={() => setEditing("")}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="ghost"
                            disabled={!signedIn || busy}
                            onClick={() => {
                              setEditing(entry.key);
                              setDraft(entry.value ?? "");
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="ghost"
                            disabled={!signedIn || busy || !entry.overridden}
                            onClick={() => void reset(entry.key)}
                          >
                            Reset
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {promptEntry ? (
        <PromptModal
          entry={promptEntry}
          busy={busy}
          onClose={() => setPromptEntry(null)}
          onSave={async (value) => save(promptEntry.key, value)}
        />
      ) : null}
    </div>
  );
};

const DatabaseView = () => {
  const { auth, signedIn } = useAuth();
  const client = useMemo(() => createPlatformWebClient(auth, "ragbot").databaseServiceClient(), [auth]);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [rows, setRows] = useState<JsonRecord[]>([]);
  const [meta, setMeta] = useState<JsonRecord | null>(null);
  const [schemas, setSchemas] = useState<TableSchema[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const loadSchemas = async () => {
    const tables = await client.query({
      sql: "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      params: [],
    });
    const schemaEntries = await Promise.all(
      (tables.rows as JsonRecord[]).map(async (row) => {
        const name = String(row.name ?? "");
        const pragma = await client.query({ sql: `PRAGMA table_info("${name.replace(/"/g, "\"\"")}")`, params: [] });
        return {
          name,
          sql: String(row.sql ?? ""),
          columns: (pragma.rows as JsonRecord[]).map((column) => ({
            cid: Number(column.cid ?? 0),
            name: String(column.name ?? ""),
            type: String(column.type ?? ""),
            notNull: Number(column.notnull ?? 0) === 1,
            defaultValue: String(column.dflt_value ?? ""),
            primaryKey: Number(column.pk ?? 0) === 1,
          })),
        };
      }),
    );
    setSchemas(schemaEntries);
  };

  const run = async () => {
    setBusy(true);
    setNote("");
    try {
      const result = await client.query({ sql, params: [] });
      setRows((result.rows ?? []) as JsonRecord[]);
      setMeta((result.meta as JsonRecord | undefined) ?? null);
    } catch (err) {
      setRows([]);
      setMeta(null);
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refreshSchemas = async () => {
    setBusy(true);
    setNote("");
    try {
      await loadSchemas();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!signedIn) return;
    void refreshSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Database</h1>
          <p className="hint">Run admin queries and inspect table schemas side by side.</p>
        </div>
        <div className="view-actions">
          <button className="ghost" disabled={!signedIn || busy} onClick={() => void refreshSchemas()}>
            Refresh schemas
          </button>
          <button disabled={!signedIn || busy || !sql.trim()} onClick={() => void run()}>
            {busy ? "Running..." : "Run query"}
          </button>
        </div>
      </div>
      {note ? <div className="note error">{note}</div> : null}
      <div className="content-grid wide">
        <div className="stack">
          <section className="section">
            <div className="section-head">
              <h2>SQL</h2>
            </div>
            <textarea
              className="editor"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={8}
              spellCheck={false}
            />
          </section>
          <section className="section">
            <div className="section-head">
              <h2>Rows</h2>
            </div>
            {rows.length > 0 ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      {Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index}>
                        {Array.from(new Set(rows.flatMap((entry) => Object.keys(entry)))).map((column) => (
                          <td key={column} className="mono">
                            {scalar(row[column])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">No rows returned.</div>
            )}
          </section>
          <ResultBlock title="Meta" value={meta ?? {}} />
        </div>

        <section className="section">
          <div className="section-head">
            <h2>Tables & Schemas</h2>
          </div>
          <div className="schema-list">
            {schemas.map((table) => (
              <article key={table.name} className="schema-card">
                <div className="schema-card-head">
                  <h3>{table.name}</h3>
                </div>
                <pre className="result compact-result">{table.sql}</pre>
                <div className="table-scroll">
                  <table className="data-table compact-table">
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>Type</th>
                        <th>Flags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.columns.map((column) => (
                        <tr key={`${table.name}-${column.cid}`}>
                          <td className="mono">{column.name}</td>
                          <td className="mono">{column.type}</td>
                          <td>
                            {column.primaryKey ? "PK " : ""}
                            {column.notNull ? "NOT NULL " : ""}
                            {column.defaultValue ? `DEFAULT ${column.defaultValue}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

const GatewayView = () => {
  const { auth, signedIn } = useAuth();
  const client = useMemo(() => createPlatformWebClient(auth, "ragbot").gatewayControlServiceClient(), [auth]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [state, setState] = useState<JsonRecord | null>(null);

  const load = async () => {
    setBusy(true);
    setNote("");
    try {
      const result = await client.getHealth({});
      setState((result.state as JsonRecord | undefined) ?? {});
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setNote("");
    try {
      const result = await client.startGateway({});
      setState((result.state as JsonRecord | undefined) ?? {});
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

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Gateway Control</h1>
          <p className="hint">Discord gateway health and restart controls.</p>
        </div>
        <div className="view-actions">
          <button className="ghost" disabled={!signedIn || busy} onClick={() => void load()}>
            Refresh
          </button>
          <button disabled={!signedIn || busy} onClick={() => void start()}>
            Start Gateway
          </button>
        </div>
      </div>
      {note ? <div className="note error">{note}</div> : null}
      <ResultBlock title="State" value={state ?? {}} />
    </div>
  );
};

const ObservabilityView = () => {
  const { auth, signedIn } = useAuth();
  const client = useMemo(() => createPlatformWebClient(auth, "idp").traceServiceClient(), [auth]);
  const [summaries, setSummaries] = useState<TraceSummary[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailSpans, setDetailSpans] = useState<TraceRow[]>([]);
  const [liveTraces, setLiveTraces] = useState<LiveTrace[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");
  const [liveNote, setLiveNote] = useState("");
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const load = async () => {
    setBusy(true);
    setNote("");
    try {
      const result = await client.listTraces({ limit: 50 });
      setSummaries(result.traces ?? []);
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
      const result = await client.getTrace({ traceId });
      setDetailSpans((result.spans ?? []).map(parseTrace).sort((a: TraceRow, b: TraceRow) => a.startMs - b.startMs));
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const start = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    while (!abort.signal.aborted) {
      try {
        setLiveNote("Streaming OTLP and gateway-local spans");
        for await (const message of client.streamTraces({}, { signal: abort.signal })) {
          const span = message.span;
          if (!span || span.name.includes("TraceService/StreamTraces")) continue;
          const parsed = parseTrace(span);
          setLiveTraces((current) => {
            const next = [...current];
            const index = next.findIndex((trace) => trace.traceId === message.traceId);
            if (index >= 0) {
              const trace = next[index];
              if (trace.spans.some((entry) => entry.spanId === parsed.spanId)) return current;
              next[index] = {
                ...trace,
                spans: [...trace.spans, parsed].sort((a, b) => a.startMs - b.startMs),
              };
              return next;
            }
            return [{ traceId: message.traceId, expanded: true, spans: [parsed] }, ...next].slice(
              0,
              MAX_LIVE_TRACES,
            );
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        setLiveNote(`Reconnecting (${(err as Error).message})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    setRunning(false);
  };

  const stop = () => {
    controller.current?.abort();
    setRunning(false);
    setLiveNote("Paused");
  };

  const toggleLive = (traceId: string) =>
    setLiveTraces((current) =>
      current.map((trace) => (trace.traceId === traceId ? { ...trace, expanded: !trace.expanded } : trace)),
    );

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Observability</h1>
          <p className="hint">Recent traces and live span flow across worker OTLP exports and gateway spans.</p>
        </div>
        <div className="view-actions">
          <button className="ghost" disabled={!signedIn || busy} onClick={() => void load()}>
            Refresh
          </button>
          {running ? (
            <button className="ghost" onClick={stop}>Pause Live</button>
          ) : (
            <button disabled={!signedIn} onClick={() => void start()}>Watch Live</button>
          )}
        </div>
      </div>
      {note ? <div className="note error">{note}</div> : null}
      <div className="content-grid wide">
        <section className="section">
          <div className="section-head">
            <h2>Recent Traces</h2>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Root</th>
                  <th>Service</th>
                  <th>Actor</th>
                  <th>Spans</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {summaries.length > 0 ? (
                  summaries.map((trace) => (
                    <tr
                      key={trace.traceId}
                      className={detailId === trace.traceId ? "selected" : ""}
                      onClick={() => void openDetail(trace.traceId)}
                    >
                      <td className="mono">{shortTraceName(trace.root || trace.traceId)}</td>
                      <td>{trace.service}</td>
                      <td>{trace.actor || "-"}</td>
                      <td>{trace.spans}</td>
                      <td>{Number(trace.durationMs)} ms</td>
                      <td>{trace.status}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="empty-state" colSpan={6}>
                      {signedIn ? "No traces loaded." : "Sign in to load traces."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h2>{detailId ? `Trace ${detailId}` : "Trace Detail"}</h2>
          </div>
          {detailSpans.length > 0 ? (
            <div className="waterfall">
              {detailSpans.map((span) => {
                const byId = new Map(detailSpans.map((entry) => [entry.spanId, entry]));
                return (
                  <div key={span.spanId} className="trace-detail-row">
                    <div
                      className={`waterfall-label svc-c${serviceClass(span.service)}`}
                      style={{ paddingLeft: `${spanDepth(span, byId) * 0.9}rem` }}
                    >
                      <span className="waterfall-service">{span.service}</span>
                      {shortTraceName(span.name)}
                    </div>
                    <div className="mono">{span.durationMs} ms</div>
                    {Object.keys(span.attributes).length > 0 ? (
                      <pre className="result compact-result">{jsonStringify(span.attributes)}</pre>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">Select a trace to inspect its spans.</div>
          )}
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Live Trace Feed</h2>
          <span className="hint">{liveNote || "Start live view to follow spans as they arrive."}</span>
        </div>
        <div className="trace-feed">
          {liveTraces.length === 0 ? (
            <div className="empty-state">No live traces yet.</div>
          ) : (
            liveTraces.map((trace) => {
              const traceStart = Math.min(...trace.spans.map((span) => span.startMs));
              const traceEnd = Math.max(...trace.spans.map((span) => span.startMs + span.durationMs));
              const total = Math.max(traceEnd - traceStart, 1);
              const actor =
                (trace.spans.map((span) => span.attributes.actor).find((value) => typeof value === "string") as
                  string | undefined) ?? "";
              return (
                <div key={trace.traceId} className="trace-card">
                  <button className="trace-card-head" onClick={() => toggleLive(trace.traceId)}>
                    <span className="trace-root">{shortTraceName(trace.spans[0]?.name ?? trace.traceId)}</span>
                    {actor ? <span className="trace-actor">{actor}</span> : null}
                    <span className="trace-meta">{trace.spans.length} hops · {total} ms</span>
                    <span className="trace-caret">{trace.expanded ? "▾" : "▸"}</span>
                  </button>
                  {trace.expanded ? (
                    <div className="waterfall">
                      {trace.spans.map((span) => {
                        const byId = new Map(trace.spans.map((entry) => [entry.spanId, entry]));
                        return (
                          <div key={span.spanId} className="waterfall-row-static">
                            <div
                              className={`waterfall-label svc-c${serviceClass(span.service)}`}
                              style={{ paddingLeft: `${spanDepth(span, byId) * 0.9}rem` }}
                            >
                              <span className="waterfall-service">{span.service}</span>
                              {shortTraceName(span.name)}
                            </div>
                            <div className="mono">{span.durationMs} ms</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
};

const ChatView = () => {
  const { auth, signedIn } = useAuth();
  const client = useMemo(() => createPlatformWebClient(auth, "ragbot").chatServiceClient(), [auth]);
  const [prompt, setPrompt] = useState("");
  const [requesterUsername, setRequesterUsername] = useState("");
  const [channelId, setChannelId] = useState("");
  const [messageId, setMessageId] = useState("");
  const [replyContext, setReplyContext] = useState("");
  const [postToChannel, setPostToChannel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [response, setResponse] = useState("");
  const [finalInfo, setFinalInfo] = useState<JsonRecord | null>(null);

  const send = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setNote("");
    setResponse("");
    setFinalInfo(null);
    try {
      let full = "";
      for await (const chunk of client.streamChat({
        prompt,
        requesterUsername,
        channelId,
        messageId,
        replyContext,
        postToChannel,
      })) {
        if (chunk.done) {
          full = chunk.responseText || full;
          setResponse(full);
          setFinalInfo({
            model: chunk.model,
            aiDurationMs: chunk.aiDurationMs.toString(),
            totalDurationMs: chunk.totalDurationMs.toString(),
          });
        } else {
          full += chunk.delta;
          setResponse(full);
        }
      }
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1>Chat</h1>
          <p className="hint">Manual ragbot chat call with streaming response output.</p>
        </div>
        <div className="view-actions">
          <button disabled={!signedIn || busy || !prompt.trim()} onClick={() => void send()}>
            {busy ? "Streaming..." : "Send"}
          </button>
        </div>
      </div>
      {note ? <div className="note error">{note}</div> : null}
      <div className="content-grid">
        <section className="section">
          <div className="form-grid">
            <label>
              <span>Requester username</span>
              <input value={requesterUsername} onChange={(e) => setRequesterUsername(e.target.value)} />
            </label>
            <label>
              <span>Channel ID</span>
              <input value={channelId} onChange={(e) => setChannelId(e.target.value)} spellCheck={false} />
            </label>
            <label>
              <span>Message ID</span>
              <input value={messageId} onChange={(e) => setMessageId(e.target.value)} spellCheck={false} />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={postToChannel}
                onChange={(e) => setPostToChannel(e.target.checked)}
              />
              <span>Post response back to Discord channel</span>
            </label>
          </div>
          <label className="stack-field">
            <span>Reply context</span>
            <textarea
              className="editor compact"
              value={replyContext}
              onChange={(e) => setReplyContext(e.target.value)}
              rows={4}
              spellCheck={false}
            />
          </label>
          <label className="stack-field">
            <span>Prompt</span>
            <textarea
              className="editor"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={8}
              spellCheck={false}
            />
          </label>
        </section>
        <section className="section">
          <div className="section-head">
            <h2>Response</h2>
          </div>
          <pre className="result tall">{response || "Submit a prompt to stream a response."}</pre>
          <ResultBlock title="Final Chunk" value={finalInfo ?? {}} />
        </section>
      </div>
    </div>
  );
};

export function App() {
  const { auth, signedIn, signIn, signOut } = useAuth();
  const [view, setView] = useState<View>("leaderboard");

  useEffect(
    () =>
      auth.onSessionChange((state) => {
        if (state.status === "needs_login") {
          void auth.ensureAuthenticated();
        }
      }),
    [auth],
  );

  return (
    <>
      <header className="topbar">
        <div>
          <div className="brand">Ragbot Console</div>
          <div className="subhead">Admin surface for ragbot data, config, traces, and model selection</div>
        </div>
        <div className="session">
          <span className={`status${signedIn ? " active" : ""}`}>{signedIn ? "signed in" : "signed out"}</span>
          {signedIn ? (
            <button onClick={() => void signOut()}>Sign out</button>
          ) : (
            <button onClick={() => void signIn()}>Sign in</button>
          )}
        </div>
      </header>

      <main className="layout">
        <nav className="sidenav">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              className={`nav-item${entry.id === view ? " active" : ""}`}
              onClick={() => setView(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <section className="content">
          {view === "leaderboard" ? <LeaderboardView /> : null}
          {view === "interactions" ? <InteractionsView /> : null}
          {view === "models" ? <ModelsView /> : null}
          {view === "config" ? <ConfigView /> : null}
          {view === "database" ? <DatabaseView /> : null}
          {view === "gateway" ? <GatewayView /> : null}
          {view === "observability" ? <ObservabilityView /> : null}
          {view === "chat" ? <ChatView /> : null}
        </section>
      </main>
    </>
  );
}
