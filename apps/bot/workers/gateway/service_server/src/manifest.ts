import { SERVICE_OPERATIONS, SERVICE_TARGETS, SERVICE_ZONE } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

// The gateway's position: an edge service that exchanges into the workflows worker. Its
// public HTTP surface (openapi.yaml) is not a service-boundary operation; its
// one registered service operation is the DevProxy entrypoint's
// `devproxy.command` (SERVICE_OPERATIONS.gateway), the sole hop it accepts over
// a service binding — from the dev-proxy worker. Its registered operations are
// declared from the shared registry so the manifest and the boundary enforce
// the same set.
export const GATEWAY_MANIFEST: ServiceManifest = {
  service: "gateway",
  zone: SERVICE_ZONE.gateway,
  targets: [...SERVICE_TARGETS.gateway],
  operations: [...SERVICE_OPERATIONS.gateway],
  scopes: ["gateway:control:control-plane", "gateway:devproxy:management"],
};
