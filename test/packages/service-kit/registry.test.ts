import { assert, test } from "vitest";

import { manifestsToEntities, serviceResourceId, type ServiceManifest } from "@rag/service-kit/manifest";
import { authorize } from "@rag/authz/authorize";
import { connectorsToEntities } from "@rag/connectors-core/lib/registry";

const MANIFESTS: ServiceManifest[] = [
  {
    service: "gateway",
    zone: "platform",
    targets: ["workflows"],
    operations: [],
    scopes: ["gateway:control:control-plane", "gateway:devproxy:management"],
  },
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
  { service: "spend", zone: "application", targets: [], operations: ["spend"] },
];

test("method service clients are derived from the other manifests' targets", () => {
  const entities = manifestsToEntities(MANIFESTS);
  const workflowsService = entities.find(
    (entity) => entity.uid.type === "Service" && entity.uid.id === serviceResourceId("workflows", "thread_start"),
  );
  assert.ok(workflowsService);
  assert.deepEqual(workflowsService.attrs.application, { __entity: { type: "Application", id: "workflows" } });
  assert.deepEqual(workflowsService.attrs.clients, [{ __entity: { type: "Application", id: "gateway" } }]);

  // Nothing targets the gateway, so it has no clients.
  const gatewayApplication = entities.find(
    (entity) => entity.uid.type === "Application" && entity.uid.id === "gateway",
  );
  assert.ok(gatewayApplication);
  assert.deepEqual(gatewayApplication.attrs.targets, [{ __entity: { type: "Application", id: "workflows" } }]);
  const gatewayControl = entities.find(
    (entity) => entity.uid.type === "Gateway" && entity.uid.id === "control",
  );
  assert.ok(gatewayControl);
  assert.equal(gatewayControl.attrs.plane, "control-plane");
});

test("the registered snapshot authorizes exactly the manifest hops through Cedar", () => {
  const entities = manifestsToEntities(MANIFESTS);
  const operation: Record<string, string> = {
    workflows: "thread_start",
    responder: "reply.channel_message",
    spend: "spend",
  };
  const invoke = (sender: string, receiver: string) =>
    authorize(
      {
        principal: { type: "Application", id: sender },
        action: "service.invoke",
        resource: { type: "Service", id: serviceResourceId(receiver as ServiceManifest["service"], operation[receiver] ?? "unknown") },
        context: { operation: operation[receiver] ?? "unknown" },
      },
      entities,
    ).allowed;
  const exchange = (sender: string, receiver: string, fromZone: string, toZone: string) =>
    authorize(
      {
        principal: { type: "Application", id: sender },
        action: "service.exchange",
        resource: { type: "Application", id: receiver },
        context: { fromZone, toZone },
      },
      entities,
    ).allowed;

  assert.isTrue(invoke("gateway", "workflows"));
  assert.isTrue(invoke("workflows", "responder"));
  assert.isTrue(invoke("workflows", "spend"));
  assert.isFalse(invoke("responder", "gateway"));
  assert.isFalse(invoke("spend", "workflows"));
  assert.isTrue(exchange("gateway", "workflows", "platform", "application"));
  assert.isFalse(exchange("gateway", "spend", "platform", "application"));
});

test("connector registry materializes connector capability entities", () => {
  const entities = connectorsToEntities();
  const github = entities.find((entity) => entity.uid.type === "Connector" && entity.uid.id === "github-app");
  assert.ok(github);
  assert.deepInclude(github.attrs.grant as unknown[], { __entity: { type: "Application", id: "workflows" } });
  assert.deepInclude(github.attrs.fetch as unknown[], { __entity: { type: "Application", id: "dev-proxy" } });
  assert.deepInclude(github.attrs.webhookVerify as unknown[], { __entity: { type: "Application", id: "webhooks" } });

  const broker = entities.find((entity) => entity.uid.type === "Connector" && entity.uid.id === "*");
  assert.ok(broker);
  assert.equal(broker.attrs.plane, "management");
  assert.deepInclude(broker.attrs.adminList as unknown[], { __entity: { type: "Application", id: "dev-proxy" } });
});
