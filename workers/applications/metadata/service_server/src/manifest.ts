import { SERVICE_OPERATIONS, SERVICE_TARGETS, SERVICE_ZONE } from "../../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../../packages/auth/manifest";

export const METADATA_MANIFEST = {
  service: "metadata",
  zone: SERVICE_ZONE.metadata,
  targets: [...SERVICE_TARGETS.metadata],
  operations: [...SERVICE_OPERATIONS.metadata],
} satisfies ServiceManifest;
