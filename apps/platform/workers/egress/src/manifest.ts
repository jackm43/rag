import { SERVICE_OPERATIONS, SERVICE_ZONE } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

export const EGRESS_MANIFEST: ServiceManifest = {
  service: "egress",
  zone: SERVICE_ZONE.egress,
  targets: [],
  operations: [...SERVICE_OPERATIONS.egress],
};
