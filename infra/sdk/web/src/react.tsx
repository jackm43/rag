import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { BrowserAuth, type SessionState } from "./browser-auth";

export type AuthContextValue = {
  auth: BrowserAuth;
  state: SessionState;
  signedIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// AuthProvider makes one BrowserAuth instance and its live session state
// available to the React tree, so components read auth via useAuth() instead of
// having `auth`/`signedIn` drilled through props.
export const AuthProvider = ({ auth, children }: { auth: BrowserAuth; children: ReactNode }) => {
  const [state, setState] = useState<SessionState>(() => auth.state());
  useEffect(() => auth.onSessionChange(setState), [auth]);
  const value = useMemo<AuthContextValue>(
    () => ({
      auth,
      state,
      signedIn: state.status === "active",
      signIn: async () => {
        await auth.promptSignIn();
      },
      signOut: async () => {
        await auth.logout();
      },
    }),
    [auth, state],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return context;
};

// AuthBoundary renders children only while a session is active; otherwise it
// renders the optional fallback (the initial login redirect is handled once at
// bootstrap, so this guards re-render after a session is lost).
export const AuthBoundary = ({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) => {
  const { signedIn } = useAuth();
  return <>{signedIn ? children : fallback}</>;
};
