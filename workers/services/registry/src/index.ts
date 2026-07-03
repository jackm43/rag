import { ServiceRegistry } from "./registry";

// The service registry worker: hosts the ServiceRegistry Durable Object and
// nothing else. It has no route and no queue — it is reachable only through the
// SERVICE_REGISTRY binding that the other workers declare, so extracting it
// here means no internet-facing worker owns the registry, and the gateway can
// be staged/redeployed under any name without moving the registry's state.
export { ServiceRegistry };

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
