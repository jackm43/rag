import { SERVICE_OPERATIONS, SERVICE_ZONE } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

// The spend service's position: an application service reconciling AI spend
// events; accepts the spend job and exchanges into nothing. Its registered
// operations are declared from the shared registry so the manifest and the
// boundary enforce the same set. (The wire operation is the "spend" envelope
// kind emitted by encodeAiSpendJobEnvelope, not "spend.reconcile".)
export const SPEND_MANIFEST: ServiceManifest = {
  service: "spend",
  zone: SERVICE_ZONE.spend,
  targets: [],
  operations: [...SERVICE_OPERATIONS.spend],
};
