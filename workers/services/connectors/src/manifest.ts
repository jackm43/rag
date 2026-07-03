import { SERVICE_OPERATIONS, SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

// The credential broker's position: an application-zone service that accepts the
// single connector.invoke operation and exchanges into nothing (its egress is
// provider HTTP through a boundary client, not a service hop). Who may call it is
// derived by the registry from the OTHER manifests' targets (the workflows worker lists
// `connectors`), so the broker cannot grant itself callers.
export const CONNECTORS_MANIFEST: ServiceManifest = {
  service: "connectors",
  zone: SERVICE_ZONE.connectors,
  targets: [],
  operations: [...SERVICE_OPERATIONS.connectors],
};
