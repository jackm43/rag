import { SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

// The responder's position: an application service (the sole Discord write
// egress) accepting reply operations and exchanging into nothing.
export const RESPONDER_MANIFEST: ServiceManifest = {
  service: "responder",
  zone: SERVICE_ZONE.responder,
  targets: [],
  operations: ["reply.channel_message", "reply.interaction_edit"],
};
