import { useEffect, useMemo, useRef, useState } from "react";

import {
  createPlatformWebClient,
  registerChatInstance,
  type ChatInstance,
  type ConfigEntry,
  type ModelInfo,
  type RagInteraction,
} from "@platy/web";
import { useAuth } from "@platy/web/react";

type View = "leaderboard" | "interactions" | "models" | "chat";
type Message = { role: "user" | "assistant"; content: string; pending?: boolean; error?: boolean };
type Interaction = RagInteraction;
type RagTotal = { userId: string; username: string; ragCount: number; updatedAt: string };
type AiGatewayClient = ReturnType<ReturnType<typeof createPlatformWebClient>["chatServiceClient"]>;

const MODEL_KEYS = ["ai_response_model", "ai_mention_model", "ai_roast_model"] as const;
const PROMPT_KEYS = ["ai_system_prompt", "ai_roast_system_prompt"] as const;
const DEFAULT_MODEL = "workers-ai/@cf/meta/llama-3.1-8b-instruct";

const clampLimit = (value: number, fallback = 20): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), 100) : fallback;

export function App() {
  const { auth, signedIn, signIn, signOut } = useAuth();
  const [view, setView] = useState<View>("leaderboard");
  const [note, setNote] = useState("");

  const leaderboardClient = useMemo(() => createPlatformWebClient(auth, "ragbot").leaderboardServiceClient(), [auth]);
  const interactionClient = useMemo(() => createPlatformWebClient(auth, "ragbot").interactionServiceClient(), [auth]);
  const configClient = useMemo(() => createPlatformWebClient(auth, "ragbot").configServiceClient(), [auth]);
  const modelClient = useMemo(() => createPlatformWebClient(auth, "aigateway").chatServiceClient(), [auth]);

  const [totals, setTotals] = useState<RagTotal[]>([]);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);

  const [chatId, setChatId] = useState<string | null>(null);
  const [chatInstance, setChatInstance] = useState<ChatInstance | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatModel, setChatModel] = useState(DEFAULT_MODEL);
  const [chatBusy, setChatBusy] = useState(false);
  const chatClient = useRef<AiGatewayClient | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const entryMap = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);

  const loadData = async () => {
    setBusy(true);
    setNote("");
    try {
      const [board, items, config, catalog] = await Promise.all([
        leaderboardClient.listTotals({ limit: 50 }),
        interactionClient.listInteractions({ limit: 50 }),
        configClient.listConfig({}),
        modelClient.listModels({ filter: "", limit: 500 }),
      ]);
      setTotals(board.totals ?? []);
      setInteractions(items.interactions ?? []);
      setEntries(config.entries ?? []);
      setModels(catalog.models ?? []);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (signedIn) void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const saveConfig = async (key: string, value: string) => {
    setBusy(true);
    setNote("");
    try {
      const result = await configClient.updateConfig({ key, value });
      if (result.entry) {
        setEntries((current) => {
          const next = current.filter((entry) => entry.key !== key);
          next.push(result.entry!);
          return next;
        });
      }
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ensureChat = async () => {
    if (chatId && chatClient.current) {
      return chatClient.current;
    }
    const instance = await registerChatInstance(auth);
    setChatInstance(instance);
    setChatId(instance.id);
    const client = createPlatformWebClient(auth, "aigateway", { headers: instance.headers }).chatServiceClient();
    chatClient.current = client;
    return client;
  };

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setChatInput("");
    setChatBusy(true);
    setMessages((current) => [...current, { role: "user", content: text }, { role: "assistant", content: "", pending: true }]);
    try {
      const client = await ensureChat();
      const stream = client.streamComplete({
        model: chatModel,
        messages: [{ role: "user", content: text }],
      });
      let content = "";
      for await (const chunk of stream) {
        if (!chunk.done && chunk.delta) {
          content += chunk.delta;
          setMessages((current) => {
            const next = [...current];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { role: "assistant", content };
            }
            return next;
          });
        }
      }
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = { role: "assistant", content: content || "(empty)" };
        }
        return next;
      });
    } catch (err) {
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = { role: "assistant", content: (err as Error).message, error: true };
        }
        return next;
      });
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="brand">Ragbot Portal</div>
        <div className="session">
          <span className={`status ${signedIn ? "active" : ""}`}>
            {signedIn ? (chatInstance?.id ? `chat ${chatInstance.id}` : "signed in") : "sign in with discord"}
          </span>
          {signedIn ? (
            <button id="logout" onClick={() => void signOut()}>
              Sign out
            </button>
          ) : (
            <button onClick={() => void signIn()}>Sign in</button>
          )}
        </div>
      </header>

      <main className="layout">
        <nav className="tabs">
          {(["leaderboard", "interactions", "models", "chat"] as View[]).map((tab) => (
            <button key={tab} className={view === tab ? "active" : ""} onClick={() => setView(tab)}>
              {tab}
            </button>
          ))}
          <button disabled={!signedIn || busy} onClick={() => void loadData()}>
            {busy ? "Loading..." : "Refresh"}
          </button>
        </nav>
        {note ? <div className="note error">{note}</div> : null}

        {view === "leaderboard" ? (
          <section className="section">
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
                {totals.map((row) => (
                  <tr key={`${row.userId}-${row.updatedAt}`}>
                    <td>{row.username}</td>
                    <td className="mono">{row.userId}</td>
                    <td>{row.ragCount.toString()}</td>
                    <td className="mono">{row.updatedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {view === "interactions" ? (
          <section className="section table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>User</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {interactions.map((item) => (
                  <tr key={item.id.toString()}>
                    <td className="mono">{item.id.toString()}</td>
                    <td>{item.requesterUsername}</td>
                    <td className="mono">{item.model}</td>
                    <td>{item.status}</td>
                    <td className="mono">{item.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {view === "models" ? (
          <section className="section content-grid">
            {MODEL_KEYS.map((key) => {
              const entry = entryMap.get(key);
              return (
                <label key={key} className="field-block">
                  <span>{key}</span>
                  <select
                    value={entry?.value ?? ""}
                    disabled={!signedIn || busy}
                    onChange={(e) => void saveConfig(key, e.target.value)}
                  >
                    {(models.length > 0 ? models : [{ id: entry?.value ?? DEFAULT_MODEL, provider: "", costIn: 0, costOut: 0 }]).map(
                      (model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              );
            })}
            {PROMPT_KEYS.map((key) => {
              const entry = entryMap.get(key);
              return (
                <label key={key} className="field-block wide">
                  <span>{key}</span>
                  <textarea
                    rows={6}
                    defaultValue={entry?.value ?? ""}
                    disabled={!signedIn || busy}
                    onBlur={(e) => {
                      if (e.target.value !== (entry?.value ?? "")) {
                        void saveConfig(key, e.target.value);
                      }
                    }}
                  />
                </label>
              );
            })}
          </section>
        ) : null}

        {view === "chat" ? (
          <section className="chat-shell">
            <div className="chat-toolbar">
              <label className="inline-field">
                <span>Model</span>
                <select value={chatModel} onChange={(e) => setChatModel(e.target.value)}>
                  {(models.length > 0 ? models : [{ id: DEFAULT_MODEL, provider: "", costIn: 0, costOut: 0 }]).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="messages" ref={scroller}>
              {messages.map((message, index) => (
                <div key={index} className={`message ${message.role}${message.error ? " error" : ""}`}>
                  <div className="bubble">{message.content || (message.pending ? "..." : "")}</div>
                </div>
              ))}
            </div>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void sendChat();
              }}
            >
              <textarea
                value={chatInput}
                rows={2}
                placeholder={signedIn ? "Message the bot..." : "Sign in to chat"}
                disabled={!signedIn || chatBusy}
                onChange={(e) => setChatInput(e.target.value)}
              />
              <button type="submit" disabled={!signedIn || chatBusy || !chatInput.trim()}>
                Send
              </button>
            </form>
          </section>
        ) : null}
      </main>
    </>
  );
}
