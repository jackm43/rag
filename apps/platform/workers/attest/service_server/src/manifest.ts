import { SERVICE_OPERATIONS, SERVICE_ZONE } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

export const ATTEST_MANIFEST: ServiceManifest = {
  service: "attest",
  zone: SERVICE_ZONE.attest,
  targets: ["attest", "connectors"],
  operations: [...SERVICE_OPERATIONS.attest],
};
