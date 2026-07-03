import { SERVICE_OPERATIONS, SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

// The gateway's position: an edge service that exchanges into the brain and
// accepts no service-boundary operations (its inbound surface is public HTTP,
// described by openapi.yaml). Its registered operations are declared from the
// shared registry so the manifest and the boundary enforce the same set.
export const GATEWAY_MANIFEST: ServiceManifest = {
  service: "gateway",
  zone: SERVICE_ZONE.gateway,
  targets: ["brain"],
  operations: [...SERVICE_OPERATIONS.gateway],
};
