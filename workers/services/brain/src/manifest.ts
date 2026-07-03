import { SERVICE_OPERATIONS, SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

// The brain's position: an application service consuming AI jobs from the
// gateway and exchanging into the responder (Discord egress) and spend
// (reconciliation) services. Its registered operations are declared from the
// shared registry so the manifest and the boundary enforce the same set.
export const BRAIN_MANIFEST: ServiceManifest = {
  service: "brain",
  zone: SERVICE_ZONE.brain,
  targets: ["responder", "spend"],
  operations: [...SERVICE_OPERATIONS.brain],
};
