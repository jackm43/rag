import { assert, test } from "vitest";

import type { Principal } from "@rag/edge-kit";
import { evaluate, isAdmin, POLICY, type PolicyEnv, type PolicyTable } from "@rag/auth/src/policy";

const web = (subject: string): Principal => ({ subject, kind: "web" });
const native = (roles: string[]): Principal => ({ subject: "op", kind: "native", roles });

const ENV: PolicyEnv = {
  RAG_ADMIN_USER_IDS: "admin-1",
  APP_ALLOWED_SUBJECTS: "user-1,user-2",
};

// A local table exercises every branch of the evaluator independently of the
// shipped POLICY.
const TABLE: PolicyTable = {
  demo: {
    "web.subject": { kinds: ["web"], subjectsFrom: "APP_ALLOWED_SUBJECTS", allowAdmin: true },
    "native.op": { kinds: ["native"], roles: ["operator"] },
  },
};

test("deny by default: an action with no policy entry is refused", () => {
  const result = evaluate(TABLE, ENV, { principal: web("user-1"), app: "demo", action: "unknown" });
  assert.deepEqual(result, { ok: false, status: 403, reason: "no_policy" });
});

test("subject allowlist: allowed subjects pass, others get subject_denied", () => {
  assert.equal(evaluate(TABLE, ENV, { principal: web("user-1"), app: "demo", action: "web.subject" }).ok, true);
  const denied = evaluate(TABLE, ENV, { principal: web("stranger"), app: "demo", action: "web.subject" });
  assert.equal(denied.ok, false);
  assert.equal((denied as { reason: string }).reason, "subject_denied");
});

test("admin bypasses the subject allowlist", () => {
  assert.equal(isAdmin(ENV, "admin-1"), true);
  assert.equal(evaluate(TABLE, ENV, { principal: web("admin-1"), app: "demo", action: "web.subject" }).ok, true);
});

test("wrong client kind is refused", () => {
  const denied = evaluate(TABLE, ENV, { principal: native(["operator"]), app: "demo", action: "web.subject" });
  assert.equal(denied.ok, false);
  assert.equal((denied as { reason: string }).reason, "kind_denied");
});

test("role constraint: matching role passes, missing role denied", () => {
  assert.equal(evaluate(TABLE, ENV, { principal: native(["operator"]), app: "demo", action: "native.op" }).ok, true);
  const denied = evaluate(TABLE, ENV, { principal: native([]), app: "demo", action: "native.op" });
  assert.equal(denied.ok, false);
  assert.equal((denied as { reason: string }).reason, "role_denied");
});

test("shipped POLICY: gateway control requires the native operator role", () => {
  assert.equal(evaluate(POLICY, ENV, { principal: native(["operator"]), app: "gateway", action: "gateway.control" }).ok, true);
  assert.equal(evaluate(POLICY, ENV, { principal: web("anyone"), app: "gateway", action: "gateway.control" }).ok, false);
});

test("shipped POLICY: webhook ingest is open to signature-verified webhook principals", () => {
  const principal: Principal = { subject: "evt-1", kind: "webhook" };
  assert.equal(evaluate(POLICY, ENV, { principal, app: "webhooks", action: "webhook.ingest" }).ok, true);
});
