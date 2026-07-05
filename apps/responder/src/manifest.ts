import { SERVICE_OPERATIONS, SERVICE_ZONE } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

// The responder's position: an application service accepting reply operations.
// Discord writes cross the egress boundary as a sidecar policy decision, not as
// a domain application target.
export const RESPONDER_MANIFEST: ServiceManifest = {
  service: "responder",
  zone: SERVICE_ZONE.responder,
  targets: [],
  operations: [...SERVICE_OPERATIONS.responder],
};
