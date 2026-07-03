import { SERVICE_OPERATIONS, SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

// The webhooks worker's position: an edge service (public third-party POSTs on
// its own subdomain) that exchanges into the connectors broker (signature
// verification) and the workflows worker (the verified-event enqueue). Like the dev-proxy,
// its ingress is public HTTP, so it registers no service operations of its own
// (SERVICE_OPERATIONS.webhooks is empty) — it only SENDS hops. Declaring the
// two targets lets the registry-driven service.exchange/invoke policies
// authorize them; the broker still gates which connector may be verified
// (connectors.cedar) and the workflows worker's boundary still gates the envelope kind.
export const WEBHOOKS_MANIFEST: ServiceManifest = {
  service: "webhooks",
  zone: SERVICE_ZONE.webhooks,
  targets: ["connectors", "workflows"],
  operations: [...SERVICE_OPERATIONS.webhooks],
};
