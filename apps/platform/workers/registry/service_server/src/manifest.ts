import { SERVICE_OPERATIONS, SERVICE_TARGETS, SERVICE_ZONE } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

export const REGISTRY_MANIFEST = {
  service: "registry",
  zone: SERVICE_ZONE.registry,
  targets: [...SERVICE_TARGETS.registry],
  operations: [...SERVICE_OPERATIONS.registry],
} satisfies ServiceManifest;
