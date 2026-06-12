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
  // discovery, and ragbot prefixes, so no CORS is involved.
  const auth = new TrustZoneWebAuth(`${location.origin}/api/discovery`, {
    sameOrigin: ["gateway", "deploy", "discovery", "ragbot"],
  });
  try {
    await auth.init();
    if (location.pathname === "/callback") {
      await auth.handleRedirect();
      history.replaceState(null, "", "/");
      mount(auth, auth.isAuthenticated());
      return;
    }
  } catch (err) {
    document.getElementById("root")!.textContent = `startup error: ${(err as Error).message}`;
    return;
  }

  // Silent bootstrap when a gateway session already exists; otherwise the SDK
  // redirects through the auth gateway OIDC flow. The login guard keeps a
  // failing login from looping.
  const status = await auth.ensureAuthenticated();
  if (status === "login_redirect") {
    return;
  }

  mount(auth, auth.isAuthenticated());
})();
