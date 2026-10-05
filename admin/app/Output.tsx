import type { Reply, Result } from "./api.ts";

const json = (value: unknown) => JSON.stringify(value ?? null, null, 2);

function Message({ reply }: { reply: Reply }) {
  return (
    <article className="reply">
      <strong>ragbot</strong>
      {reply.content && <p>{reply.content}</p>}
      {reply.attachments?.map((file) => (
        <figure key={file.name}>
          {file.dataUrl?.startsWith("data:image/") && <img src={file.dataUrl} alt={file.name} />}
          {file.dataUrl?.startsWith("data:audio/") && <audio controls src={file.dataUrl} />}
          <figcaption className="muted small">
            {file.name} · {file.contentType} · {(file.bytes / 1024).toFixed(0)} KiB
          </figcaption>
        </figure>
      ))}
    </article>
  );
}

export function Output({ page, result }: { page: string; result?: Result }) {
  if (!result) {
    return (
      <section className="card output">
        <h2>Output</h2>
        <p className="muted">{page === "bicture" ? "The generated image appears here." : "Replies and captured Discord calls appear here."}</p>
      </section>
    );
  }
  const replies = result.replies ?? [...(result.edits ?? []), ...(result.followUps ?? []), ...(result.channelMessages ?? [])];
  const failures = result.ai.filter((exchange) => exchange.error);
  const revisions = [...new Set(result.ai.map((exchange) => exchange.settingsRevision).filter(Boolean))];
  const sections: [string, unknown][] = [
    ["Discord input", result.message ?? result.interaction],
    ["AI requests", result.ai.map(({ model, request, settingsRevision }) => ({ model, settingsRevision, request }))],
    ["AI responses", result.ai.map(({ model, response, error, durationMs }) => ({ model, durationMs, error, response }))],
    ["Captured Discord and network calls", result.calls],
    ["Worker logs", result.logs],
    ["Sandbox database effects", result.db],
  ];
  return (
    <section className="card output">
      <div className="card-header">
        <h2>Output</h2>
        <span className="muted small">
          {(result.durationMs / 1000).toFixed(1)} s{revisions.length > 0 && ` · settings ${revisions.join(", ")}`}
        </span>
      </div>
      {replies.map((reply, index) => (
        <Message key={reply.id ?? index} reply={reply} />
      ))}
      {failures.map((exchange, index) => (
        <p key={index} className="error">
          {exchange.model} failed with {exchange.error}.
        </p>
      ))}
      {!replies.length && !failures.length && <p className="muted">No reply was sent. Check the logs and database effects below.</p>}
      <h3>Request details</h3>
      {sections.map(([title, value]) => (
        <details key={title} className="inspect">
          <summary>{title}</summary>
          <pre>{json(value)}</pre>
        </details>
      ))}
    </section>
  );
}
