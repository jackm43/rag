import { SERVICE_ZONE } from "../../../../packages/auth/principal";
import type { ServiceManifest } from "../../../../packages/auth/manifest";

// The brain's position: an application service consuming AI jobs from the
// gateway and exchanging into the responder (Discord egress) and spend
// (reconciliation) services.
export const BRAIN_MANIFEST: ServiceManifest = {
  service: "brain",
  zone: SERVICE_ZONE.brain,
  targets: ["responder", "spend"],
  operations: [
    "thread_start",
    "thread_reply",
    "channel_reply",
    "ask",
    "ragjam",
    "bicture",
    "message.received",
  ],
};
