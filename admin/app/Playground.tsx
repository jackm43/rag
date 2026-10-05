import { useEffect, useState, type FormEvent } from "react";
import { api, remember, remembered, snowflake, targetName, type Command, type HistoryEntry, type Meta, type Result, type Target } from "./api.ts";

export type Identity = {
  userId: string;
  username: string;
  globalName: string;
  nick: string;
  botUserId: string;
  guildId: string;
  channelId: string;
  modsRole: boolean;
};
type Turn = { id: string; role: "user" | "bot"; content: string; author?: Partial<Identity> };
type Replay = { prompt: string; at: number } | undefined;

/** Unsent text that survives reloads, per field. */
function useDraftText(key: string, replay: Replay) {
  const [value, setValue] = useState<string>(() => remembered(`text:${key}`, ""));
  useEffect(() => remember(`text:${key}`, value), [key, value]);
  useEffect(() => {
    if (replay) setValue(replay.prompt);
  }, [replay]);
  return [value, setValue] as const;
}

export function ChatPanel({ identity, replay, busy, onSend }: {
  identity: Identity;
  replay: Replay;
  busy: boolean;
  onSend: (body: object, sent: (result: Result) => void) => Promise<void>;
}) {
  const [content, setContent] = useDraftText("chat", replay);
  const [mentionBot, setMentionBot] = useState(true);
  const [replyLast, setReplyLast] = useState(false);
  const [transcripts, setTranscripts] = useState<Record<string, Turn[]>>(() => remembered("transcripts", {}));
  const transcript = transcripts[identity.channelId] ?? [];
  useEffect(() => remember("transcripts", transcripts), [transcripts]);
  useEffect(() => {
    if (replay) {
      setMentionBot(true);
      setReplyLast(false);
    }
  }, [replay]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!content.trim()) return;
    const channelId = identity.channelId;
    const lastBot = transcript.findLast((turn) => turn.role === "bot");
    void onSend({ content, mentionBot, transcript, replyToId: replyLast ? lastBot?.id : undefined }, ({ message, replies = [] }) => {
      setTranscripts((current) => ({
        ...current,
        [channelId]: [
          ...(current[channelId] ?? []),
          { id: message!.id, role: "user", content: message!.content, author: identity },
          ...replies.map((reply) => ({ id: reply.id ?? snowflake(), role: "bot" as const, content: reply.content })),
        ],
      }));
      setContent("");
    });
  };

  return (
    <section className="card">
      <div className="card-header">
        <h2>Conversation</h2>
        {transcript.length > 0 && (
          <button type="button" className="link" disabled={busy} onClick={() => setTranscripts({ ...transcripts, [identity.channelId]: [] })}>
            Clear
          </button>
        )}
      </div>
      {transcript.length > 0 ? (
        <ol className="transcript">
          {transcript.map((turn) => (
            <li key={turn.id} className={turn.role}>
              <strong>{turn.role === "bot" ? "ragbot" : turn.author?.nick || turn.author?.globalName || turn.author?.username || "user"}</strong>
              <p>{turn.content}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">No messages in this channel yet.</p>
      )}
      <form onSubmit={submit}>
        <label>
          Message
          <textarea
            rows={4}
            required
            value={content}
            placeholder="Ask ragbot something…"
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
            }}
          />
        </label>
        <div className="actions">
          <label className="check">
            <input type="checkbox" checked={mentionBot} onChange={(event) => setMentionBot(event.target.checked)} />
            Mention the bot
          </label>
          <label className="check">
            <input type="checkbox" checked={replyLast} onChange={(event) => setReplyLast(event.target.checked)} />
            Reply to the last bot message
          </label>
          <span className="spacer" />
          <button type="submit" disabled={busy || !content.trim()}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

export function CommandPanel({ command, replay, busy, onRun }: {
  command: Command;
  replay: Replay;
  busy: boolean;
  onRun: (body: object) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => remembered(`options:${command.name}`, {}));
  useEffect(() => remember(`options:${command.name}`, values), [command.name, values]);
  useEffect(() => {
    if (replay && command.options.some((option) => option.name === "prompt")) setValues((current) => ({ ...current, "prompt:value": replay.prompt }));
  }, [replay, command]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const options = [];
    const resolvedUsers: Record<string, object> = {};
    for (const option of command.options) {
      const value = values[`${option.name}:value`]?.trim() ?? (option.type === 6 ? "123456789012345679" : "");
      if (!value) continue;
      options.push({ name: option.name, type: option.type, value });
      if (option.type === 6) resolvedUsers[value] = { userId: value, username: values[`${option.name}:username`]?.trim() || `user_${value.slice(-4)}` };
    }
    void onRun({ options, resolvedUsers });
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="card-header">
        <h2>Run /{command.name}</h2>
      </div>
      {command.options.length > 0 ? (
        <div className="fields">
          {command.options.flatMap((option) =>
            (option.type === 6 ? (["value", "username"] as const) : (["value"] as const)).map((field) => {
              const key = `${option.name}:${field}`;
              const long = (option.max_length ?? 0) > 200;
              const props = {
                value: values[key] ?? (option.type === 6 ? (field === "value" ? "123456789012345679" : "sample_user") : ""),
                required: field === "value" && option.required,
                minLength: field === "value" ? option.min_length : undefined,
                maxLength: field === "value" ? option.max_length : undefined,
                placeholder: option.type === 6 && field === "value" ? "User ID" : option.description,
                onChange: (event: { target: { value: string } }) => setValues({ ...values, [key]: event.target.value }),
              };
              return (
                <label key={key} className={long ? "wide" : undefined}>
                  {option.name}
                  {field === "username" ? " username" : option.required ? " *" : ""}
                  {long ? <textarea rows={4} {...props} /> : <input {...props} />}
                </label>
              );
            }),
          )}
        </div>
      ) : (
        <p className="muted small">This command has no options.</p>
      )}
      <div className="actions">
        <span className="spacer" />
        <button type="submit" disabled={busy}>
          {command.name === "bicture" ? "Generate image" : `Run /${command.name}`}
        </button>
      </div>
    </form>
  );
}

export function HistoryPanel({ page, target, busy, run, onUse }: {
  page: string;
  target: Target;
  busy: boolean;
  run: (task: () => Promise<string | void>) => Promise<void>;
  onUse: (prompt: string) => void;
}) {
  const [source, setSource] = useState<Target>(target);
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>();
  const [next, setNext] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  const load = (older: boolean) =>
    run(async () => {
      const result = await api<{ entries: HistoryEntry[]; next: number | null }>("history", {
        target: source,
        page,
        search,
        before: older ? next : null,
      });
      setEntries([...(older ? (entries ?? []) : []), ...result.entries]);
      setNext(result.next);
      return "Prompt history loaded.";
    });
  const reset = () => {
    setEntries(undefined);
    setNext(null);
  };
  const when = (value: string) => {
    const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  };

  return (
    <details className="card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <h2>Prompt history</h2>
      </summary>
      <form
        className="fields"
        onSubmit={(event) => {
          event.preventDefault();
          void load(false);
        }}
      >
        <label>
          Source
          <select
            value={source}
            onChange={(event) => {
              setSource(event.target.value as Target);
              reset();
            }}
          >
            <option value="live">{targetName("live")}</option>
            <option value="sandbox">{targetName("sandbox")}</option>
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            maxLength={500}
            value={search}
            placeholder="Prompt text"
            onChange={(event) => {
              setSearch(event.target.value);
              reset();
            }}
          />
        </label>
        <div className="actions wide">
          <button type="submit" disabled={busy}>
            Fetch {page === "bicture" ? "image prompts" : "chat prompts"}
          </button>
        </div>
      </form>
      {entries && (
        <ul className="history">
          {entries.length === 0 && <li className="muted small">No saved prompts match.</li>}
          {entries.map((entry) => (
            <li key={entry.id}>
              <details>
                <summary>
                  <span className="preview">{entry.prompt}</span>
                  <span className="muted small">
                    {when(entry.created_at)} · {entry.requester_username || "user"} · {entry.model}
                    {entry.status !== "ok" && " · failed"}
                  </span>
                </summary>
                <pre>{entry.prompt}</pre>
                {entry.response_text && (
                  <>
                    <p className="muted small">Response</p>
                    <pre>{entry.response_text}</pre>
                  </>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      onUse(entry.prompt);
                      setOpen(false);
                    }}
                  >
                    Use this prompt
                  </button>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
      {next !== null && (
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => load(true)}>
            Load older
          </button>
        </div>
      )}
    </details>
  );
}

export function IdentityPanel({ meta, identity, onChange }: { meta: Meta; identity: Identity; onChange: (identity: Identity) => void }) {
  const text = (field: keyof Identity, label: string, pattern?: string) => (
    <label>
      {label}
      <input
        value={identity[field] as string}
        pattern={pattern}
        spellCheck={false}
        onChange={(event) => onChange({ ...identity, [field]: event.target.value })}
      />
    </label>
  );
  return (
    <details className="card">
      <summary>
        <h2>Discord simulation</h2>
      </summary>
      <p className="muted small">
        Discord calls are captured, never sent. The default user is on the admin allowlist and has the Mods role, so every command can run.
        Simulated commands write only to the sandbox database.
      </p>
      <div className="fields">
        {text("userId", "User ID", "[0-9]{17,20}")}
        {text("username", "Username")}
        {text("globalName", "Display name")}
        {text("nick", "Server nickname")}
        {text("botUserId", "Bot ID", "[0-9]{17,20}")}
        {text("guildId", "Server ID", "[0-9]{17,20}")}
        {text("channelId", "Channel ID", "[0-9]{17,20}")}
        <label className="check">
          <input type="checkbox" checked={identity.modsRole} onChange={(event) => onChange({ ...identity, modsRole: event.target.checked })} />
          Has the Mods role
        </label>
      </div>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => onChange({ ...identity, channelId: snowflake() })}>
          New channel
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => onChange({ ...meta.defaults, nick: "", botUserId: meta.applicationId, guildId: meta.guildId, channelId: snowflake(), modsRole: true })}
        >
          Restore defaults
        </button>
      </div>
    </details>
  );
}
