import { SERVICE_OPERATIONS, SERVICE_TARGETS, SERVICE_ZONE } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

export const METADATA_MANIFEST = {
  service: "metadata",
  zone: SERVICE_ZONE.metadata,
  targets: [...SERVICE_TARGETS.metadata],
  operations: [...SERVICE_OPERATIONS.metadata],
} satisfies ServiceManifest;
