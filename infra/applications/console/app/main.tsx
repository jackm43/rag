import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TrustZoneWebAuth } from "../../../sdk/web/src";

import { App } from "./App";

const mount = (auth: TrustZoneWebAuth, signedIn: boolean) => {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <App auth={auth} signedIn={signedIn} />
    </StrictMode>,
  );
};

(async () => {
  // Discovery and all API calls are same-origin: zone routes put the gateway
  // (/idp.v1.*, /api/*, jwks) on this host, and the BFF proxies the deploy,
  // discovery, and ragbot prefixes, so no CORS is involved. One call handles
  // discovery, the OIDC callback, and silent refresh / login redirect.
  try {
    const { auth, status } = await TrustZoneWebAuth.bootstrap(`${location.origin}/api/discovery`, {
      sameOrigin: ["gateway", "deploy", "discovery", "ragbot"],
    });
    if (status === "login_redirect") {
      return;
    }
    mount(auth, auth.isAuthenticated());
  } catch (err) {
    document.getElementById("root")!.textContent = `startup error: ${(err as Error).message}`;
  }
})();
