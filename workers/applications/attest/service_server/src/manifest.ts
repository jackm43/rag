import { SERVICE_OPERATIONS, SERVICE_ZONE } from "../../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../../packages/auth/manifest";

export const ATTEST_MANIFEST: ServiceManifest = {
  service: "attest",
  zone: SERVICE_ZONE.attest,
  targets: ["attest", "connectors"],
  operations: [...SERVICE_OPERATIONS.attest],
};
