import { SERVICE_OPERATIONS, SERVICE_ZONE } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

// The credential broker's position: an application-zone service that accepts the
// single connector.invoke operation. Provider HTTP crosses the egress boundary
// as a sidecar policy decision, not as a domain application target. Who may call
// the broker is derived by the registry from the OTHER manifests' targets (the
// workflows worker lists `connectors`), so the broker cannot grant itself callers.
export const CONNECTORS_MANIFEST: ServiceManifest = {
  service: "connectors",
  zone: SERVICE_ZONE.connectors,
  targets: [],
  operations: [...SERVICE_OPERATIONS.connectors],
};
