import { useEffect, useMemo, useState } from "react";

import { discoveryServiceClient } from "../../discovery/web";
import type { TrustZoneWebAuth } from "../../../sdk/web/src";

import { Applications } from "./Applications";
import { Config } from "./Config";
import { Delegations } from "./Delegations";
import { Deploy } from "./Deploy";
import { Identity } from "./Identity";
import { Traces } from "./Traces";

type View = "applications" | "delegations" | "deploy" | "config" | "traces" | "identity";

const VIEWS: { id: View; label: string }[] = [
  { id: "applications", label: "Applications" },
  { id: "delegations", label: "Delegations" },
  { id: "deploy", label: "Deploy" },
  { id: "config", label: "Config" },
  { id: "traces", label: "Traces" },
  { id: "identity", label: "Identity" },
];

export function App({ auth, signedIn: initialSignedIn }: { auth: TrustZoneWebAuth; signedIn: boolean }) {
  const [signedIn, setSignedIn] = useState(initialSignedIn);
  const [view, setView] = useState<View>("applications");

  // One discovery client for the whole console; the generated factory binds
  // the session transport, so it only needs the initialized auth.
  const discovery = useMemo(() => {
    try {
      return discoveryServiceClient(auth);
    } catch {
      return null;
    }
  }, [auth]);

  // Mid-session loss (refresh token expired or revoked): route back through
  // ensureAuthenticated - silent refresh if possible, otherwise the redirect
  // login (guarded against loops by the SDK).
  useEffect(
    () =>
      auth.onSessionChange((state) => {
        setSignedIn(state.status === "active");
        if (state.status === "needs_login") {
          void auth.ensureAuthenticated();
        }
      }),
    [auth],
  );

  return (
    <>
      <header className="topbar">
        <div className="brand">Platform Console</div>
        <div className="session">
          <span className={`status${signedIn ? " active" : ""}`}>{signedIn ? "signed in" : "signed out"}</span>
          {signedIn ? (
            <button
              onClick={async () => {
                await auth.logout();
                setSignedIn(false);
              }}
            >
              Sign out
            </button>
          ) : (
            <button onClick={() => void auth.promptSignIn()}>Sign in</button>
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
          {view === "applications" ? (
            <Applications auth={auth} signedIn={signedIn} discovery={discovery} />
          ) : null}
          {view === "delegations" ? <Delegations signedIn={signedIn} discovery={discovery} /> : null}
          {view === "deploy" ? <Deploy auth={auth} signedIn={signedIn} /> : null}
          {view === "config" ? <Config auth={auth} signedIn={signedIn} /> : null}
          {view === "traces" ? <Traces auth={auth} signedIn={signedIn} /> : null}
          {view === "identity" ? <Identity auth={auth} signedIn={signedIn} /> : null}
        </section>
      </main>
    </>
  );
}
