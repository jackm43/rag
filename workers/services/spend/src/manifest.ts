import { SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

// The spend service's position: an application service reconciling AI spend
// events; accepts spend jobs and exchanges into nothing.
export const SPEND_MANIFEST: ServiceManifest = {
  service: "spend",
  zone: SERVICE_ZONE.spend,
  targets: [],
  operations: ["spend.reconcile"],
};
