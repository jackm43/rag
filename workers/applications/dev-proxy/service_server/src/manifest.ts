import { SERVICE_OPERATIONS, SERVICE_ZONE } from "../../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../../packages/auth/manifest";

// The dev-proxy's position: an edge service that exchanges into the gateway (the
// command surface) and the connectors broker (the admin surface), and exposes no
// service-boundary operations of its own (its ingress is public HTTP gated by
// Cloudflare Access + a Better Auth Discord session). Registering the manifest
// lets the registry-driven authorizer derive the dev-proxy → gateway and
// dev-proxy → connectors hops from attributes as well as the static bootstrap
// permits.
export const DEV_PROXY_MANIFEST: ServiceManifest = {
  service: "dev-proxy",
  zone: SERVICE_ZONE["dev-proxy"],
  targets: ["gateway", "connectors"],
  operations: [...SERVICE_OPERATIONS["dev-proxy"]],
};
