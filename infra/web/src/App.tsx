import { useEffect, useMemo, useRef, useState } from "react";
import type { Client } from "@connectrpc/connect";

import { createChatServiceClient } from "../../applications/aigateway/web";
import type { ChatService } from "../../applications/aigateway/server/aigateway/v1/aigateway_pb";
import {
  CLIENT_INSTANCE_HEADER,
  registerChatInstance,
  type ChatInstance,
  type TrustZoneWebAuth,
} from "../../sdk/web/src";

import { DataPanel } from "./DataPanel";
import { LiveTraces } from "./LiveTraces";

type Role = "system" | "user" | "assistant";
type Message = { role: Role; content: string; model?: string; pending?: boolean; error?: boolean };
type ModelInfo = { id: string; provider: string; costIn: number; costOut: number };
type Chat = { id: string; title: string; messages: Message[] };
type ModelSort = "name" | "costIn" | "costOut";

const DEFAULT_MODEL = "workers-ai/@cf/meta/llama-3.1-8b-instruct";

const localChatId = (): string => Math.random().toString(36).slice(2, 12);

const costLabel = (m: ModelInfo): string =>
  m.costIn > 0 || m.costOut > 0
    ? `$${(m.costIn * 1e6).toFixed(2)}/M in · $${(m.costOut * 1e6).toFixed(2)}/M out`
    : "included";

export function App({ auth, signedIn: initialSignedIn }: { auth: TrustZoneWebAuth; signedIn: boolean }) {
  const [signedIn, setSignedIn] = useState(initialSignedIn);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<ModelSort>("name");
  const scroller = useRef<HTMLDivElement>(null);
  // One typed client per chat: each is its own factory instance carrying the
  // chat's registered identity headers on every request.
  const clients = useRef(new Map<string, Client<typeof ChatService>>());
  const instances = useRef(new Map<string, ChatInstance>());
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const active = chats.find((chat) => chat.id === activeId) ?? null;

  const clientFor = (chatId: string): Client<typeof ChatService> => {
    let client = clients.current.get(chatId);
    if (!client) {
      const headers = instances.current.get(chatId)?.headers ?? { [CLIENT_INSTANCE_HEADER]: chatId };
      client = createChatServiceClient(auth, { headers });
      clients.current.set(chatId, client);
    }
    return client;
  };

  // Registers the chat instance with the web application's worker during
  // client auth: the response is a signed chat identity document bound to
  // this web session. Falls back to a local id if registration fails so the
  // UI still works.
  const newChat = async () => {
    let id = localChatId();
    try {
      const instance = await registerChatInstance(auth);
      id = instance.id;
      instances.current.set(id, instance);
    } catch {
      // Keep the local id.
    }
    setChats((current) => [...current, { id, title: `Chat ${current.length + 1}`, messages: [] }]);
    setActiveId(id);
  };

  const sortedModels = useMemo(() => {
    const sorted = [...models];
    if (sortBy === "name") {
      sorted.sort((a, b) => a.id.localeCompare(b.id));
    } else {
      sorted.sort((a, b) => a[sortBy] - b[sortBy] || a.id.localeCompare(b.id));
    }
    return sorted;
  }, [models, sortBy]);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [active?.messages]);

  // Mid-session loss (refresh token expired or revoked): drop the clients and
  // route back through ensureAuthenticated — silent refresh if possible,
  // otherwise the redirect login (guarded against loops by the SDK).
  useEffect(
    () =>
      auth.onSessionChange((state) => {
        setSignedIn(state.status === "active");
        if (state.status === "needs_login") {
          clients.current.clear();
          void auth.ensureAuthenticated();
        }
      }),
    [auth],
  );

  const loadModels = async (filter: string) => {
    if (!activeId) return;
    try {
      const res = await clientFor(activeId).listModels({ filter, limit: 100 });
      setModels(res.models as ModelInfo[]);
      setTotal(res.total);
    } catch (err) {
      setNote(`could not load models: ${(err as Error).message}`);
    }
  };

  useEffect(() => {
    if (!signedIn) return;
    if (chats.length === 0) {
      void newChat();
      return;
    }
    void loadModels("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, auth, activeId]);

  const onSearch = (value: string) => {
    setSearch(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void loadModels(value), 200);
  };

  const updateChat = (chatId: string, mutate: (messages: Message[]) => Message[]) =>
    setChats((current) =>
      current.map((chat) => (chat.id === chatId ? { ...chat, messages: mutate(chat.messages) } : chat)),
    );

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy || !active) return;
    const chatId = active.id;
    setInput("");
    setBusy(true);

    const history: Message[] = [...active.messages, { role: "user", content: text }];
    updateChat(chatId, () => [...history, { role: "assistant", content: "", pending: true }]);

    const patchLast = (patch: Partial<Message>) =>
      updateChat(chatId, (messages) => {
        const next = [...messages];
        next[next.length - 1] = { ...next[next.length - 1], ...patch };
        return next;
      });

    try {
      const request = {
        model,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: 512,
        temperature: -1, // negative => provider default
      };
      let acc = "";
      for await (const chunk of clientFor(chatId).streamComplete(request)) {
        if (!chunk.done) {
          acc += chunk.delta;
          patchLast({ content: acc, pending: true });
        } else {
          patchLast({ content: chunk.content || acc, model: chunk.model, pending: false });
        }
      }
      patchLast({ pending: false });
    } catch (err) {
      patchLast({ content: `error: ${(err as Error).message}`, error: true, pending: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="brand"><span className="lock">🔐</span> Trust Zone Chat</div>
        <div className="session">
          <span className={`status${signedIn ? " active" : ""}`}>{signedIn ? "signed in" : "signed out"}</span>
          {signedIn ? (
            <button
              onClick={async () => {
                await auth.logout();
                setSignedIn(false);
                clients.current.clear();
                setChats([]);
                setActiveId(null);
              }}
            >
              Sign out
            </button>
          ) : (
            <button onClick={() => auth.login()}>Sign in</button>
          )}
        </div>
      </header>

      <main className="layout">
        <div className="workspace">
        <div className="chat-column">
        <div className="chat-tabs">
          {chats.map((chat) => (
            <button
              key={chat.id}
              className={`chat-tab${chat.id === activeId ? " active" : ""}`}
              title={`instance ${chat.id}`}
              onClick={() => setActiveId(chat.id)}
            >
              {chat.title}
            </button>
          ))}
          <button className="chat-tab new" disabled={!signedIn} onClick={() => void newChat()}>
            + New chat
          </button>
        </div>

        <div className="controls">
          <label>Model</label>
          <div className="model-picker">
            <button
              type="button"
              className="model-current"
              disabled={!signedIn}
              onClick={() => setPickerOpen((open) => !open)}
            >
              <span className="model-id">{model}</span>
              <span className="model-caret">▾</span>
            </button>
            {pickerOpen ? (
              <div className="model-menu">
                <div className="model-menu-controls">
                  <input
                    autoFocus
                    placeholder="filter models…"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    spellCheck={false}
                  />
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as ModelSort)}>
                    <option value="name">sort: name</option>
                    <option value="costIn">sort: $/M in</option>
                    <option value="costOut">sort: $/M out</option>
                  </select>
                </div>
                <div className="model-options">
                  {sortedModels.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`model-option${m.id === model ? " active" : ""}`}
                      onClick={() => {
                        setModel(m.id);
                        setPickerOpen(false);
                      }}
                    >
                      <span className="model-id">{m.id}</span>
                      <span className="model-cost">{costLabel(m)}</span>
                    </button>
                  ))}
                  {total > models.length ? (
                    <span className="model-more">
                      showing {models.length} of {total} — filter to narrow
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
          <span className="hint">{note}</span>
        </div>

        <section className="messages" ref={scroller} aria-live="polite">
          {(active?.messages ?? []).map((m, i) => (
            <div key={i} className={`message ${m.role}${m.error ? " error" : ""}`}>
              {m.content || (m.pending ? "…" : "")}
            </div>
          ))}
        </section>

        <form className="composer" onSubmit={send}>
          <textarea
            rows={2}
            placeholder={signedIn ? "Ask the AI Gateway…" : "Sign in to chat"}
            value={input}
            disabled={!signedIn || busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(e); }
            }}
          />
          <button type="submit" disabled={!signedIn || busy}>Send</button>
        </form>
        </div>

        <LiveTraces auth={auth} signedIn={signedIn} />
        </div>

        <DataPanel auth={auth} signedIn={signedIn} wide />
      </main>
    </>
  );
}
