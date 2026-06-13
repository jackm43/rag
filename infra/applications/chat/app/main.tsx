import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { BrowserAuth } from "../../../sdk/web/src";

import { App } from "./App";

const mount = (auth: BrowserAuth, signedIn: boolean) => {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <App auth={auth} signedIn={signedIn} />
    </StrictMode>,
  );
};

(async () => {
  // Discovery and all API calls are same-origin: zone routes put the gateway
  // (/idp.v1.*, /api/*, jwks) and the AI Gateway (/aigateway.v1.*) on this
  // host, so no CORS is involved. One call handles discovery, the OIDC
  // callback, and silent refresh / login redirect.
  try {
    const { auth, status } = await BrowserAuth.bootstrap(`${location.origin}/api/discovery`, {
      sameOrigin: ["gateway", "aigateway", "ragbot"],
    });
    if (status === "login_redirect") {
      return;
    }
    mount(auth, auth.isAuthenticated());
  } catch (err) {
    document.getElementById("root")!.textContent = `startup error: ${(err as Error).message}`;
  }
})();
