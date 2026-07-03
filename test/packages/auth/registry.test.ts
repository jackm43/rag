import { assert, test } from "vitest";

import { manifestsToEntities, type ServiceManifest } from "../../../packages/auth/manifest.ts";
import { authorize } from "../../../packages/authz/authorize.ts";

const MANIFESTS: ServiceManifest[] = [
  { service: "gateway", zone: "edge", targets: ["workflows"], operations: [] },
  {
    service: "workflows",
    zone: "application",
    targets: ["responder", "spend"],
    operations: ["thread_start", "ask"],
  },
  {
    service: "responder",
    zone: "application",
    targets: [],
    operations: ["reply.channel_message", "reply.interaction_edit"],
  },
  { service: "spend", zone: "application", targets: [], operations: ["spend.reconcile"] },
];

test("a service's clients are derived from the other manifests' targets", () => {
  const entities = manifestsToEntities(MANIFESTS);
  const workflowsService = entities.find(
    (entity) => entity.uid.type === "Service" && entity.uid.id === "workflows",
  );
  assert.ok(workflowsService);
  assert.deepEqual(workflowsService.attrs.clients, [{ __entity: { type: "Machine", id: "gateway" } }]);

  // Nothing targets the gateway, so it has no clients.
  const gatewayService = entities.find(
    (entity) => entity.uid.type === "Service" && entity.uid.id === "gateway",
  );
  assert.ok(gatewayService);
  assert.deepEqual(gatewayService.attrs.clients, []);
});

test("the registered snapshot authorizes exactly the manifest hops through Cedar", () => {
  const entities = manifestsToEntities(MANIFESTS);
  const invoke = (sender: string, receiver: string) =>
    authorize(
      {
        principal: { type: "Machine", id: sender },
        action: "service.invoke",
        resource: { type: "Service", id: receiver },
      },
      entities,
    ).allowed;

  assert.isTrue(invoke("gateway", "workflows"));
  assert.isTrue(invoke("workflows", "responder"));
  assert.isTrue(invoke("workflows", "spend"));
  assert.isFalse(invoke("responder", "gateway"));
  assert.isFalse(invoke("spend", "workflows"));
});
