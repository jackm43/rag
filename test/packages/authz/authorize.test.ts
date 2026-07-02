import { assert, test } from "vitest";

import { authorize, type AuthzRequest } from "../../../packages/authz/authorize.ts";
import { RAG_ADMIN_USER_IDS } from "../../../packages/authz/entities.ts";

const ADMIN_ID = RAG_ADMIN_USER_IDS[0];
const OUTSIDER_ID = "999999999999999999";
const GUILD = { type: "Guild", id: "100000000000000001" } as const;

const commandRequest = (userId: string, command: string, banned = false): AuthzRequest => ({
  principal: { type: "User", id: userId },
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
  const operatorRequest = (action: string): AuthzRequest => ({
    principal: { type: "Operator", id: "control" },
    action,
    resource: { type: "Gateway", id: "control" },
  });

  for (const action of ["gateway.start", "gateway.stop", "gateway.health"]) {
    assert.isTrue(authorize(operatorRequest(action)).allowed, action);
  }
  assert.isFalse(authorize(operatorRequest("gateway.reboot")).allowed);
  assert.isFalse(authorize({ ...operatorRequest("gateway.start"), principal: { type: "User", id: ADMIN_ID } }).allowed);
});

test("peer delivery is allowed for the legitimate hops and denied for the rest", () => {
  const peerRequest = (sender: string, receiver: string): AuthzRequest => ({
    principal: { type: "Peer", id: sender },
    action: "peer.deliver",
    resource: { type: "Service", id: receiver },
  });

  assert.isTrue(authorize(peerRequest("gateway", "brain")).allowed);
  assert.isTrue(authorize(peerRequest("brain", "responder")).allowed);
  assert.isTrue(authorize(peerRequest("brain", "spend")).allowed);

  assert.isFalse(authorize(peerRequest("gateway", "spend")).allowed);
  assert.isFalse(authorize(peerRequest("responder", "brain")).allowed);
  assert.isFalse(authorize(peerRequest("spend", "gateway")).allowed);
});

test("unknown actions are denied by default with no reason attached", () => {
  const decision = authorize(commandRequest(ADMIN_ID, "definitely-not-a-command"));
  assert.isFalse(decision.allowed);
  assert.isUndefined(decision.reason);
});
