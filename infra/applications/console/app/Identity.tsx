import { useEffect, useMemo, useState } from "react";

import { createPlatformWebClient } from "@platy/web";
import { useAuth } from "@platy/web/react";

type Principal = {
  kind?: string;
  sub?: string;
  email?: string;
  act?: string[];
};

type Introspection = {
  principal?: Principal;
  scopes?: string[];
};

export function Identity() {
  const { auth, signedIn } = useAuth();
  const [intro, setIntro] = useState<Introspection | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const identityClient = useMemo(() => createPlatformWebClient(auth, "idp").identityServiceClient(), [auth]);

  const load = async () => {
    setBusy(true);
    setNote("loading");
    try {
      const result = await identityClient.introspect({});
      setIntro({ principal: result.principal, scopes: result.scopes });
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

  const session = auth.state();

  return (
    <div className="view">
      <div className="view-head">
        <h1>Identity</h1>
        <div className="view-actions">
          <button disabled={!signedIn || busy} onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>
      {note ? <div className="note">{note}</div> : null}

      <div className="split">
        <div className="panel detail">
          <h2>Gateway introspection</h2>
          {intro ? (
            <dl className="kv">
              <dt>Kind</dt>
              <dd>{intro.principal?.kind || "-"}</dd>
              <dt>Sub</dt>
              <dd className="mono">{intro.principal?.sub || "-"}</dd>
              <dt>Email</dt>
              <dd className="mono">{intro.principal?.email || "-"}</dd>
              <dt>Act</dt>
              <dd>
                {(intro.principal?.act ?? []).length > 0 ? (
                  <ul>
                    {(intro.principal?.act ?? []).map((actor) => (
                      <li key={actor} className="mono">
                        {actor}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "none (direct session)"
                )}
              </dd>
              <dt>Scopes</dt>
              <dd>
                {(intro.scopes ?? []).length > 0 ? (
                  <ul>
                    {(intro.scopes ?? []).map((scope) => (
                      <li key={scope} className="scope">
                        {scope}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "-"
                )}
              </dd>
            </dl>
          ) : (
            <p className="hint">{signedIn ? "no introspection loaded" : "sign in to introspect"}</p>
          )}
        </div>

        <div className="panel detail">
          <h2>Browser session</h2>
          <dl className="kv">
            <dt>Status</dt>
            <dd>{session.status}</dd>
            {session.status === "active" ? (
              <>
                <dt>Access token expires</dt>
                <dd>{session.expiresAt.toISOString().replace("T", " ").slice(0, 19)}</dd>
              </>
            ) : null}
            {session.status === "needs_login" ? (
              <>
                <dt>Reason</dt>
                <dd>{session.reason}</dd>
              </>
            ) : null}
          </dl>
          <p className="hint">
            The session is device-bound: a non-extractable ES256 DPoP key in IndexedDB signs a proof
            on every request, and the refresh token rotates on every use.
          </p>
        </div>
      </div>
    </div>
  );
}
