import { SERVICE_OPERATIONS, SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

// The workflows worker's position: an application service consuming AI jobs from the
// gateway and webhook events from the webhooks worker, and exchanging into the
// responder (Discord egress), spend (reconciliation), and connectors
// (credential broker) services. Its registered operations are declared from
// the shared registry (which now includes webhook.event) so the manifest and
// the boundary enforce the same set; its CLIENTS (gateway, webhooks) are not
// self-declared — the registry derives them from those manifests' targets.
// Declaring `connectors` as a target lets the registry-driven
// service.exchange/invoke policies authorize the hop; the broker still gates
// which connector the workflows worker may touch (connectors.cedar).
export const WORKFLOWS_MANIFEST: ServiceManifest = {
  service: "workflows",
  zone: SERVICE_ZONE.workflows,
  targets: ["responder", "spend", "connectors"],
  operations: [...SERVICE_OPERATIONS.workflows],
};
