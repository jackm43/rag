import { SERVICE_OPERATIONS, SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

export const EGRESS_MANIFEST: ServiceManifest = {
  service: "egress",
  zone: SERVICE_ZONE.egress,
  targets: [],
  operations: [...SERVICE_OPERATIONS.egress],
};
