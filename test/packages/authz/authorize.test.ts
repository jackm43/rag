import { assert, test } from "vitest";

import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { authorize, type AuthorizationRequest } from "../../../packages/authz/authorize.ts";
import { RAG_ADMIN_USER_IDS } from "../../../packages/authz/entities.ts";

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

test("the operator may drive the gateway control routes and nothing else", () => {
  const operatorRequest = (action: string): AuthorizationRequest => ({
    principal: { type: "Machine", id: "operator" },
    action,
    resource: { type: "Gateway", id: "control" },
  });

  for (const action of ["gateway.start", "gateway.stop", "gateway.health"]) {
    assert.isTrue(authorize(operatorRequest(action)).allowed, action);
  }
  assert.isFalse(authorize(operatorRequest("gateway.reboot")).allowed);
  assert.isFalse(
    authorize({ ...operatorRequest("gateway.start"), principal: { type: "Human", id: ADMIN_ID } }).allowed,
  );
});

const invokeRequest = (sender: string, receiver: string): AuthorizationRequest => ({
  principal: { type: "Machine", id: sender },
  action: "service.invoke",
  resource: { type: "Service", id: receiver },
});

const exchangeRequest = (
  sender: string,
  receiver: string,
  fromZone: string,
  toZone: string,
): AuthorizationRequest => ({
  principal: { type: "Machine", id: sender },
  action: "service.exchange",
  resource: { type: "Service", id: receiver },
  context: { fromZone, toZone },
});

test("service invocation is allowed for the legitimate hops and denied for the rest", () => {
  assert.isTrue(authorize(invokeRequest("gateway", "brain")).allowed);
  assert.isTrue(authorize(invokeRequest("brain", "responder")).allowed);
  assert.isTrue(authorize(invokeRequest("brain", "spend")).allowed);

  assert.isFalse(authorize(invokeRequest("gateway", "spend")).allowed);
  assert.isFalse(authorize(invokeRequest("responder", "brain")).allowed);
  assert.isFalse(authorize(invokeRequest("spend", "gateway")).allowed);
});

test("service exchange is permitted only for the legitimate zone transitions", () => {
  assert.isTrue(authorize(exchangeRequest("gateway", "brain", "edge", "application")).allowed);
  assert.isTrue(authorize(exchangeRequest("brain", "responder", "application", "application")).allowed);
  assert.isTrue(authorize(exchangeRequest("brain", "spend", "application", "application")).allowed);

  // Unauthorized pair, and a legitimate pair with mismatched zones.
  assert.isFalse(authorize(exchangeRequest("responder", "brain", "application", "application")).allowed);
  assert.isFalse(authorize(exchangeRequest("gateway", "brain", "edge", "trusted")).allowed);
});

// The registry snapshot shape: Machine entities with zone/targets and Service
// entities with zone/clients, as produced by ServiceRegistry.snapshot().
const registrySnapshot = (): EntityJson[] => [
  {
    uid: { type: "Machine", id: "gateway" },
    attrs: {
      zone: "edge",
      targets: [{ __entity: { type: "Service", id: "spend" } }],
      operations: [],
    },
    parents: [],
  },
  {
    uid: { type: "Service", id: "spend" },
    attrs: {
      zone: "application",
      clients: [{ __entity: { type: "Machine", id: "gateway" } }],
    },
    parents: [],
  },
];

test("registry entities extend the static policy to registered hops", () => {
  // gateway -> spend is not a bootstrap hop, so it is denied statically...
  assert.isFalse(authorize(invokeRequest("gateway", "spend")).allowed);
  assert.isFalse(authorize(exchangeRequest("gateway", "spend", "edge", "application")).allowed);

  // ...but a registered manifest pair authorizes it through the attribute rules.
  const entities = registrySnapshot();
  assert.isTrue(authorize(invokeRequest("gateway", "spend"), entities).allowed);
  assert.isTrue(authorize(exchangeRequest("gateway", "spend", "edge", "application"), entities).allowed);

  // The registered zones still bind: a mismatched transition is denied.
  assert.isFalse(authorize(exchangeRequest("gateway", "spend", "application", "application"), entities).allowed);
});

test("unknown actions are denied by default with no reason attached", () => {
  const decision = authorize(commandRequest(ADMIN_ID, "definitely-not-a-command"));
  assert.isFalse(decision.allowed);
  assert.isUndefined(decision.reason);
});
