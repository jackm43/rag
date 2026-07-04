import { SERVICE_OPERATIONS, SERVICE_TARGETS, SERVICE_ZONE } from "../../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../../packages/auth/manifest";

export const REGISTRY_MANIFEST = {
  service: "registry",
  zone: SERVICE_ZONE.registry,
  targets: [...SERVICE_TARGETS.registry],
  operations: [...SERVICE_OPERATIONS.registry],
} satisfies ServiceManifest;
