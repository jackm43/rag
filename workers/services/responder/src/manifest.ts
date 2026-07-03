import { SERVICE_OPERATIONS, SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

// The responder's position: an application service (the sole Discord write
// egress) accepting reply operations and exchanging into nothing. Its
// registered operations are declared from the shared registry so the manifest
// and the boundary enforce the same set.
export const RESPONDER_MANIFEST: ServiceManifest = {
  service: "responder",
  zone: SERVICE_ZONE.responder,
  targets: [],
  operations: [...SERVICE_OPERATIONS.responder],
};
