import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { BrowserAuth } from "@platy/web";
import { AuthProvider } from "@platy/web/react";

import { App } from "./App";

const mount = (auth: BrowserAuth) => {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <AuthProvider auth={auth}>
        <App />
      </AuthProvider>
    </StrictMode>,
  );
};

(async () => {
  // Discovery and API calls are same-origin: zone routes put the gateway on
  // auth-gateway.jsmunro.me; the BFF proxies /platform/aigateway/v1/* and
  // /platform/ragbot/v1/* on this host.
  try {
    const { auth, status } = await BrowserAuth.bootstrap(`${location.origin}/api/discovery`, {
      sameOrigin: ["gateway", "idp", "aigateway", "ragbot"],
    });
    if (status === "login_redirect") {
      return;
    }
    mount(auth);
  } catch (err) {
    document.getElementById("root")!.textContent = `startup error: ${(err as Error).message}`;
  }
})();
