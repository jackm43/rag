import { useCallback, useEffect, useState } from "react";
import { api, remember, remembered, snowflake, targetName, type Catalog, type Draft, type Meta, type Result, type Saved, type Target } from "./api.ts";
import { Output } from "./Output.tsx";
import { ChatPanel, CommandPanel, HistoryPanel, IdentityPanel, type Identity } from "./Playground.tsx";
import { SettingsPanel } from "./Settings.tsx";

const SETTINGS_PAGES = ["chat", "bicture"];

const clone = (saved: Saved): Draft => structuredClone({ chat: saved.settings.chat, image: saved.settings.image });

/** The draft as one page sees it: that page's edits on top of the saved settings for the other. */
export function pageDraft(saved: Saved, draft: Draft, page: string): Draft {
  return page === "bicture" ? { chat: saved.settings.chat, image: draft.image } : { chat: draft.chat, image: saved.settings.image };
}

export const isDirty = (saved: Saved | null, draft: Draft | null, page: string) =>
  Boolean(saved && draft && SETTINGS_PAGES.includes(page)) &&
  JSON.stringify(pageDraft(saved!, draft!, page)) !== JSON.stringify(clone(saved!));

function usePage(meta?: Meta) {
  const read = () => location.hash.replace(/^#\/?/, "") || "chat";
  const [page, setPage] = useState(read);
  useEffect(() => {
    const update = () => setPage(read());
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return meta && !meta.commands.some((command) => command.name === page) ? "chat" : page;
}

export function App() {
  const [meta, setMeta] = useState<Meta>();
  const [target, setTarget] = useState<Target>(() => remembered("target", "live"));
  const [saved, setSaved] = useState<Saved | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [settingsError, setSettingsError] = useState<string>();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ text: "Connecting…", error: false });
  const [results, setResults] = useState<Record<string, Result>>({});
  const [identity, setIdentity] = useState<Identity | null>(() => remembered("identity", null));
  // A prompt picked from history, loaded into the composer or the prompt option.
  const [replay, setReplay] = useState<{ prompt: string; at: number }>();
  const page = usePage(meta);

  useEffect(() => remember("target", target), [target]);
  useEffect(() => remember("identity", identity), [identity]);
  useEffect(() => {
    document.title = `${page === "chat" ? "Chat" : `/${page}`} · ragbot admin`;
  }, [page]);

  const run = useCallback(async (task: () => Promise<string | void>) => {
    setBusy(true);
    setStatus({ text: "Working…", error: false });
    try {
      setStatus({ text: (await task()) || "Ready.", error: false });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(false);
    }
  }, []);

  const loadModels = useCallback(async (from: Target, refresh = false) => {
    setCatalogError(undefined);
    try {
      setCatalog(await api<Catalog>("models", { target: from, refresh }));
    } catch (error) {
      setCatalog(null);
      setCatalogError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const loadSettings = useCallback(
    async (from: Target) => {
      setSaved(null);
      setSettingsError(undefined);
      try {
        const loaded = await api<Saved>("settings/load", { target: from });
        setSaved(loaded);
        setDraft(clone(loaded));
        await loadModels(from);
      } catch (error) {
        setSettingsError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    [loadModels],
  );

  useEffect(() => {
    void run(async () => {
      const loaded = await api<Meta>("meta");
      setMeta(loaded);
      setIdentity((current) => current ?? { ...loaded.defaults, nick: "", botUserId: loaded.applicationId, guildId: loaded.guildId, channelId: snowflake(), modsRole: true });
      await loadSettings(target);
    });
    // Load once; switching targets reloads settings explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!meta || !identity) {
    return (
      <div className="boot">
        <p className={status.error ? "error" : ""}>{status.text}</p>
      </div>
    );
  }

  const command = meta.commands.find((entry) => entry.name === page);
  const editsSettings = SETTINGS_PAGES.includes(page);
  const dirty = isDirty(saved, draft, page);
  // Saved settings run as they are; only a changed draft is sent (and checked against the catalog).
  const simulation = () => {
    if (!saved || !draft) throw new Error("Load settings first.");
    if (!/^\d{17,20}$/.test(identity.userId) || !identity.username.trim()) throw new Error("Set a valid user ID and username under Discord simulation.");
    if (!/^\d{17,20}$/.test(identity.channelId)) throw new Error("Set a valid channel ID under Discord simulation.");
    const { modsRole, guildId, channelId, botUserId, ...user } = identity;
    return {
      target: saved.target,
      baseRevision: saved.revision,
      identity: user,
      modsRole,
      guildId,
      channelId,
      botUserId,
      page,
      settings: dirty ? pageDraft(saved, draft, page) : undefined,
    };
  };
  const finish = (result: Result) => {
    setResults((current) => ({ ...current, [page]: result }));
    const failed = result.ai.some((exchange) => exchange.error);
    if (failed) throw new Error("The model request failed. See Request details.");
    return `Finished in ${(result.durationMs / 1000).toFixed(1)} s.`;
  };
  const tabs = [{ name: "chat", label: "Chat" }, ...meta.commands.map((entry) => ({ name: entry.name, label: `/${entry.name}` }))];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <strong>ragbot</strong>
          <span>admin</span>
        </div>
        <nav aria-label="Pages">
          {tabs.map((tab) => (
            <a key={tab.name} href={`#/${tab.name}`} aria-current={page === tab.name ? "page" : undefined} onClick={(event) => busy && event.preventDefault()}>
              {tab.label}
            </a>
          ))}
        </nav>
        <span className="user" title="Signed in through Cloudflare Access">
          {meta.user}
        </span>
      </header>

      <main className="layout">
        <section className="column">
          <div className="page-heading">
            <h1>{page === "chat" ? "Chat playground" : `/${page}`}</h1>
            <p>
              {page === "chat"
                ? "Mention the bot with the real chat handler. Model calls are real; Discord is simulated."
                : command?.description}
              {command?.adminOnly && " · Admin allowlist only."}
              {command?.requiredRoleId && " · Mods role required."}
            </p>
          </div>

          {editsSettings && (
            <SettingsPanel
              page={page}
              target={target}
              saved={saved}
              draft={draft}
              dirty={dirty}
              catalog={catalog}
              catalogError={catalogError}
              settingsError={settingsError}
              busy={busy}
              run={run}
              onTarget={(next) => {
                setTarget(next);
                void run(async () => {
                  await loadSettings(next);
                  return `${targetName(next)} settings loaded.`;
                });
              }}
              onReload={() =>
                run(async () => {
                  await loadSettings(target);
                  return "Saved settings reloaded.";
                })
              }
              onRefreshModels={() =>
                run(async () => {
                  await loadModels(target, true);
                  return "Model list refreshed.";
                })
              }
              onDraft={setDraft}
              onSaved={(next) => {
                setSaved(next);
                setDraft(clone(next));
              }}
            />
          )}

          {page === "chat" ? (
            <ChatPanel identity={identity} replay={replay} busy={busy || !saved} onSend={(body, sent) =>
                run(async () => {
                  const result = await api<Result>("mention", { ...simulation(), ...body });
                  sent(result);
                  return finish(result);
                })
              } />
          ) : (
            command && (
              <CommandPanel
                key={command.name}
                command={command}
                replay={replay}
                busy={busy || !saved}
                onRun={(body) => run(async () => finish(await api<Result>("interaction", { ...simulation(), command: command.name, ...body })))}
              />
            )
          )}

          <p className={`status ${status.error ? "error" : ""}`} role="status" aria-live="polite">
            {status.text}
          </p>

          {editsSettings && (
            <HistoryPanel
              key={`history:${page}`}
              page={page}
              target={target}
              busy={busy}
              run={run}
              onUse={(prompt) => {
                // A replay starts a fresh conversation so unrelated context is not included.
                if (page === "chat") setIdentity({ ...identity, channelId: snowflake() });
                setReplay({ prompt, at: Date.now() });
                setStatus({ text: "Prompt loaded. It runs with the settings above.", error: false });
              }}
            />
          )}
          <IdentityPanel meta={meta} identity={identity} onChange={setIdentity} />
        </section>

        <section className="column">
          <Output page={page} result={results[page]} />
        </section>
      </main>
    </div>
  );
}
