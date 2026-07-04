import { assert, test } from "vitest";

import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { authorize, type AuthorizationRequest } from "@rag/authz/authorize";
import { RAG_ADMIN_USER_IDS } from "@rag/authz/entities";

const ADMIN_ID = RAG_ADMIN_USER_IDS[0];
const OUTSIDER_ID = "999999999999999999";
const GUILD = { type: "Guild", id: "100000000000000001" } as const;

const commandRequest = (userId: string, command: string, banned = false): AuthorizationRequest => ({
  principal: { type: "Human", id: userId },
  action: `command.${command}`,
  resource: GUILD,
  context: { banned },
});

const ADMIN_COMMANDS = ["raghammer", "ragunban", "undorag"];
const BAN_GATED_COMMANDS = ["rag", "ask", "bicture", "ragjam"];
const PUBLIC_COMMANDS = ["rag", "ragboard", "ragspend", "ragspendboard", "ask", "bicture", "ragjam"];

test("admins may run every admin command; everyone else is denied", () => {
  for (const command of ADMIN_COMMANDS) {
    for (const adminId of RAG_ADMIN_USER_IDS) {
      assert.isTrue(authorize(commandRequest(adminId, command)).allowed, `${command} for admin`);
    }
    assert.isFalse(authorize(commandRequest(OUTSIDER_ID, command)).allowed, `${command} for outsider`);
  }
});

test("every user may run the public commands when not banned", () => {
  for (const command of PUBLIC_COMMANDS) {
    assert.isTrue(authorize(commandRequest(OUTSIDER_ID, command)).allowed, command);
  }
});

test("a ban forbids /rag and the AI commands and names the banned policy", () => {
  for (const command of BAN_GATED_COMMANDS) {
    const decision = authorize(commandRequest(OUTSIDER_ID, command, true));
    assert.isFalse(decision.allowed, command);
    assert.equal(decision.reason, "banned");
  }
});

test("a banned user can still read the boards", () => {
  assert.isTrue(authorize(commandRequest(OUTSIDER_ID, "ragboard", true)).allowed);
  assert.isTrue(authorize(commandRequest(OUTSIDER_ID, "ragspend", true)).allowed);
  assert.isTrue(authorize(commandRequest(OUTSIDER_ID, "ragspendboard", true)).allowed);
});

test("a ban does not gate the admin commands", () => {
  for (const command of ADMIN_COMMANDS) {
    assert.isTrue(authorize(commandRequest(ADMIN_ID, command, true)).allowed, command);
  }
});

test("the gateway-control application may drive gateway control routes and nothing else", () => {
  const controlRequest = (action: string): AuthorizationRequest => ({
    principal: { type: "Application", id: "gateway-control" },
    action,
    resource: { type: "Gateway", id: "control" },
  });
  const gatewayControl: EntityJson = {
    uid: { type: "Gateway", id: "control" },
    attrs: { plane: "control-plane" },
    parents: [],
  };

  for (const action of ["gateway.start", "gateway.stop", "gateway.health"]) {
    assert.isTrue(authorize(controlRequest(action), [gatewayControl]).allowed, action);
  }
  assert.isFalse(authorize(controlRequest("gateway.reboot"), [gatewayControl]).allowed);
  assert.isFalse(
    authorize({ ...controlRequest("gateway.start"), principal: { type: "Human", id: ADMIN_ID } }, [gatewayControl]).allowed,
  );
});

test("management and control-plane resources cannot be crossed by action class", () => {
  const gatewayControl: EntityJson = {
    uid: { type: "Gateway", id: "control" },
    attrs: { plane: "control-plane" },
    parents: [],
  };
  const gatewayManagement: EntityJson = {
    uid: { type: "Gateway", id: "devproxy" },
    attrs: { plane: "management" },
    parents: [],
  };
  const connectorControl: EntityJson = {
    uid: { type: "Connector", id: "*" },
    attrs: {
      plane: "control-plane",
      adminRead: [{ __entity: { type: "Application", id: "dev-proxy" } }],
      adminWrite: [{ __entity: { type: "Application", id: "dev-proxy" } }],
    },
    parents: [],
  };
  const connectorManagement: EntityJson = {
    uid: { type: "Connector", id: "*" },
    attrs: {
      plane: "management",
      adminRead: [{ __entity: { type: "Application", id: "dev-proxy" } }],
      adminWrite: [{ __entity: { type: "Application", id: "dev-proxy" } }],
    },
    parents: [],
  };

  assert.isFalse(authorize({
    principal: { type: "Application", id: "dev-proxy" },
    action: "gateway.devproxy.invoke",
    resource: { type: "Gateway", id: "control" },
    context: { command: "ask" },
  }, [gatewayControl]).allowed);
  assert.isFalse(authorize({
    principal: { type: "Application", id: "gateway-control" },
    action: "gateway.start",
    resource: { type: "Gateway", id: "devproxy" },
  }, [gatewayManagement]).allowed);
  assert.isFalse(authorize({
    principal: { type: "Application", id: "dev-proxy" },
    action: "connector.admin.read",
    resource: { type: "Connector", id: "*" },
  }, [connectorControl]).allowed);
  assert.isTrue(authorize({
    principal: { type: "Application", id: "dev-proxy" },
    action: "connector.admin.read",
    resource: { type: "Connector", id: "*" },
  }, [connectorManagement]).allowed);
});

const invokeRequest = (
  sender: string,
  receiver: string,
  operation?: string,
): AuthorizationRequest => ({
  principal: { type: "Application", id: sender },
  action: "service.invoke",
  resource: { type: "Service", id: `${receiver}:${operation ?? "unknown"}` },
  ...(operation ? { context: { operation } } : {}),
});

const exchangeRequest = (
  sender: string,
  receiver: string,
  fromZone: string,
  toZone: string,
): AuthorizationRequest => ({
  principal: { type: "Application", id: sender },
  action: "service.exchange",
  resource: { type: "Application", id: receiver },
  context: { fromZone, toZone },
});

test("service invocation is allowed for the legitimate hops and denied for the rest", () => {
  const entities = registrySnapshot();
  assert.isTrue(authorize(invokeRequest("gateway", "spend", "spend"), entities).allowed);

  assert.isFalse(authorize(invokeRequest("gateway", "spend", "unknown"), entities).allowed);
  assert.isFalse(authorize(invokeRequest("responder", "workflows")).allowed);
  assert.isFalse(authorize(invokeRequest("spend", "gateway")).allowed);
});

test("service exchange is permitted only for the legitimate zone transitions", () => {
  const entities = registrySnapshot();
  assert.isTrue(authorize(exchangeRequest("gateway", "spend", "platform", "application"), entities).allowed);

  // Unauthorized pair, and a registered pair with mismatched zones.
  assert.isFalse(authorize(exchangeRequest("responder", "workflows", "application", "application")).allowed);
  assert.isFalse(authorize(exchangeRequest("gateway", "spend", "platform", "control-plane"), entities).allowed);
});

// The registry snapshot shape: Application entities with zone/targets and
// method-level Service entities with application/operation/clients, as produced
// by ServiceRegistry.snapshot().
const registrySnapshot = (): EntityJson[] => [
  {
    uid: { type: "Application", id: "gateway" },
    attrs: {
      zone: "platform",
      plane: "data",
      targets: [{ __entity: { type: "Application", id: "spend" } }],
      operations: [],
    },
    parents: [],
  },
  {
    uid: { type: "Application", id: "spend" },
    attrs: {
      zone: "application",
      plane: "data",
      targets: [],
      operations: ["spend"],
    },
    parents: [],
  },
  {
    uid: { type: "Service", id: "spend:spend" },
    attrs: {
      application: { __entity: { type: "Application", id: "spend" } },
      zone: "application",
      plane: "data",
      operation: "spend",
      clients: [{ __entity: { type: "Application", id: "gateway" } }],
    },
    parents: [],
  },
];

test("registry entities extend the static policy to registered hops", () => {
  // gateway -> spend is denied without registry/control-plane state...
  assert.isFalse(authorize(invokeRequest("gateway", "spend", "spend")).allowed);
  assert.isFalse(authorize(exchangeRequest("gateway", "spend", "platform", "application")).allowed);

  // ...but a registered manifest pair authorizes it through the attribute
  // rules, for an operation the receiver registers.
  const entities = registrySnapshot();
  assert.isTrue(authorize(invokeRequest("gateway", "spend", "spend"), entities).allowed);
  assert.isTrue(authorize(exchangeRequest("gateway", "spend", "platform", "application"), entities).allowed);

  // The registered zones still bind: a mismatched transition is denied.
  assert.isFalse(authorize(exchangeRequest("gateway", "spend", "application", "application"), entities).allowed);
});

test("egress sidecar use is authorized by dynamic sidecar callers", () => {
  const profile: EntityJson = {
    uid: { type: "EgressSidecar", id: "responder:discord-rest" },
    attrs: {
      plane: "data",
      callers: [{ __entity: { type: "Application", id: "responder" } }],
    },
    parents: [],
  };
  assert.isTrue(
    authorize(
      {
        principal: { type: "Application", id: "responder" },
        action: "egress.use",
        resource: { type: "EgressSidecar", id: "responder:discord-rest" },
      },
      [profile],
    ).allowed,
  );
  assert.isFalse(
    authorize(
      {
        principal: { type: "Application", id: "workflows" },
        action: "egress.use",
        resource: { type: "EgressSidecar", id: "responder:discord-rest" },
      },
      [profile],
    ).allowed,
  );
});

test("connector capabilities are authorized by dynamic connector entities", () => {
  const connector: EntityJson = {
    uid: { type: "Connector", id: "github-app" },
    attrs: {
      plane: "data",
      planes: ["data", "management"],
      grant: [{ __entity: { type: "Application", id: "workflows" } }],
      fetch: [{ __entity: { type: "Application", id: "workflows" } }],
      token: [],
      adminRead: [{ __entity: { type: "Application", id: "dev-proxy" } }],
    },
    parents: [],
  };
  assert.isTrue(
    authorize(
      {
        principal: { type: "Application", id: "workflows" },
        action: "connector.grant",
        resource: { type: "Connector", id: "github-app" },
      },
      [connector],
    ).allowed,
  );
  assert.isFalse(
    authorize(
      {
        principal: { type: "Application", id: "dev-proxy" },
        action: "connector.grant",
        resource: { type: "Connector", id: "github-app" },
      },
      [connector],
    ).allowed,
  );
  assert.isTrue(
    authorize(
      {
        principal: { type: "Application", id: "dev-proxy" },
        action: "connector.admin.read",
        resource: { type: "Connector", id: "github-app" },
      },
      [connector],
    ).allowed,
  );
});

test("unknown actions are denied by default with no reason attached", () => {
  const decision = authorize(commandRequest(ADMIN_ID, "definitely-not-a-command"));
  assert.isFalse(decision.allowed);
  assert.isUndefined(decision.reason);
});
