import {
  initSync,
  policySetTextToParts,
  policyToJson,
  preparsePolicySet,
  statefulIsAuthorized,
} from "@cedar-policy/cedar-wasm/web";
// The package's exports map only exposes the JS glue, so the wasm binary is
// imported by path. Wrangler's built-in CompiledWasm rule compiles it at
// deploy time; workerd hands it to us as a WebAssembly.Module.
// @ts-expect-error -- the shipped .wasm.d.ts types the wasm-bindgen bundler
// target, but under wrangler/workerd the module's default export is the
// compiled WebAssembly.Module that initSync expects.
import cedarWasmModule from "./node_modules/@cedar-policy/cedar-wasm/web/cedar_wasm_bg.wasm";
import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { staticEntities } from "./entities";
import commandPolicies from "./policies/commands.cedar";
import connectorPolicies from "./policies/connectors.cedar";
import egressPolicies from "./policies/egress.cedar";
import gatewayPolicies from "./policies/gateway.cedar";
import servicePolicies from "./policies/services.cedar";

// Centralised authorization: every boundary asks the Cedar engine instead of
// carrying its own allow/deny logic. Policies live in policies/*.cedar,
// group membership in entities.ts; callers supply request state (like the
// D1-backed ban flag) as context, and may supply dynamic entities (the
// service-registry snapshot) merged with the static store.

// A principal is either a Human (a Discord user) or an Application (a verified
// worker/application identity).
export type Principal = {
  type: "Human" | "Application";
  id: string;
};

export type Resource = {
  type: "Guild" | "Gateway" | "Application" | "Service" | "Connector" | "EgressSidecar";
  id: string;
};

export type AuthorizationRequest = {
  principal: Principal;
  action: string;
  resource: Resource;
  context?: Record<string, boolean | number | string>;
};

export type Decision = {
  allowed: boolean;
  reason?: string;
};

const POLICY_SET_ID = "ragbot";

const parseFailure = (errors: { message: string }[]) =>
  new Error(`authz policy set failed to parse: ${errors.map((error) => error.message).join("; ")}`);

// Split the .cedar sources into individual policies keyed by their @id
// annotation, so denial diagnostics name the policy that fired instead of a
// positional "policyN".
const namedPolicies = (source: string): Record<string, string> => {
  const parts = policySetTextToParts(source);
  if (parts.type === "failure") {
    throw parseFailure(parts.errors);
  }
  const policies: Record<string, string> = {};
  for (const [index, policy] of parts.policies.entries()) {
    const json = policyToJson(policy);
    const annotatedId = json.type === "success" ? json.json.annotations?.id : undefined;
    policies[annotatedId ?? `policy${index}`] = policy;
  }
  return policies;
};

let engineReady = false;

// Instantiate the wasm engine and parse the policy set once per isolate, on
// first use; statefulIsAuthorized then evaluates against the cached set.
const ensureEngine = () => {
  if (engineReady) {
    return;
  }
  initSync({ module: cedarWasmModule });
  const parsed = preparsePolicySet(POLICY_SET_ID, {
    staticPolicies: namedPolicies(
      [commandPolicies, connectorPolicies, egressPolicies, gatewayPolicies, servicePolicies].join(
        "\n\n",
      ),
    ),
  });
  if (parsed.type === "failure") {
    throw parseFailure(parsed.errors);
  }
  engineReady = true;
};

// Deny-by-default: only an explicit permit (with no overriding forbid)
// allows. reason names the forbid policies behind an explicit denial, or the
// evaluation errors when the engine itself fails (which also denies).
// dynamicEntities carries control-plane snapshots (service registry, gateway
// state, egress sidecar state) when the caller has one.
export const authorize = (
  request: AuthorizationRequest,
  dynamicEntities: EntityJson[] = [],
): Decision => {
  ensureEngine();
  const answer = statefulIsAuthorized({
    principal: request.principal,
    action: { type: "Action", id: request.action },
    resource: request.resource,
    context: request.context ?? {},
    preparsedPolicySetId: POLICY_SET_ID,
    entities: dynamicEntities.length > 0 ? [...staticEntities, ...dynamicEntities] : staticEntities,
  });
  if (answer.type === "failure") {
    return { allowed: false, reason: answer.errors.map((error) => error.message).join("; ") };
  }
  if (answer.response.decision === "allow") {
    return { allowed: true };
  }
  const forbids = answer.response.diagnostics.reason;
  return forbids.length > 0 ? { allowed: false, reason: forbids.join(", ") } : { allowed: false };
};
