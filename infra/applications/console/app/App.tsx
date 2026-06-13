import { useEffect, useMemo, useState } from "react";

import { discovery } from "../../discovery/web";
import { useAuth } from "@platy/web/react";

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

export function App() {
  const { auth, signedIn, signIn, signOut } = useAuth();
  const [view, setView] = useState<View>("applications");

  // One discovery client for the whole console; the generated factory binds
  // the session transport, so it only needs the initialized auth.
  const discoveryClient = useMemo(() => {
    try {
      return discovery.discoveryServiceClient(auth);
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
          {view === "applications" ? <Applications discovery={discoveryClient} /> : null}
          {view === "delegations" ? <Delegations discovery={discoveryClient} /> : null}
          {view === "deploy" ? <Deploy /> : null}
          {view === "config" ? <Config /> : null}
          {view === "traces" ? <Traces /> : null}
          {view === "identity" ? <Identity /> : null}
        </section>
      </main>
    </>
  );
}
