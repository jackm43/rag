import { assert, test } from "vitest";

import type { Principal } from "@rag/edge-kit";
import { evaluate, isAdmin, POLICY, type PolicyEnv } from "@rag/auth/src/policy";

const web = (subject: string): Principal => ({ subject, kind: "web" });
const native = (roles: string[]): Principal => ({ subject: "op", kind: "native", roles });

const ENV: PolicyEnv = {
  RAG_ADMIN_USER_IDS: "admin-1",
  DEV_PROXY_ALLOWED_SUBJECTS: "user-1,user-2",
};

test("deny by default: an action with no policy entry is refused", () => {
  const result = evaluate(POLICY, ENV, { principal: web("user-1"), app: "demo", action: "unknown" });
  assert.deepEqual(result, { ok: false, status: 403, reason: "no_policy" });
});

test("dev-proxy web command: allowed only for allowlisted subjects", () => {
  assert.equal(evaluate(POLICY, ENV, { principal: web("user-1"), app: "dev-proxy", action: "command.dispatch" }).ok, true);
  const denied = evaluate(POLICY, ENV, { principal: web("stranger"), app: "dev-proxy", action: "command.dispatch" });
  assert.equal(denied.ok, false);
  assert.equal((denied as { reason: string }).reason, "subject_denied");
});

test("admin bypasses the subject allowlist", () => {
  assert.equal(isAdmin(ENV, "admin-1"), true);
  assert.equal(
    evaluate(POLICY, ENV, { principal: web("admin-1"), app: "dev-proxy", action: "command.dispatch" }).ok,
    true,
  );
});

test("wrong client kind is refused", () => {
  const denied = evaluate(POLICY, ENV, { principal: native(["operator"]), app: "dev-proxy", action: "command.dispatch" });
  assert.equal(denied.ok, false);
  assert.equal((denied as { reason: string }).reason, "kind_denied");
});

test("gateway control: native operator role required", () => {
  assert.equal(evaluate(POLICY, ENV, { principal: native(["operator"]), app: "gateway", action: "gateway.control" }).ok, true);
  const denied = evaluate(POLICY, ENV, { principal: native([]), app: "gateway", action: "gateway.control" });
  assert.equal(denied.ok, false);
  assert.equal((denied as { reason: string }).reason, "role_denied");
});
