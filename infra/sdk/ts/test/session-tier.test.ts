import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMUNITY_SESSION_SCOPE,
  directExchangeGrants,
  INTERNAL_SESSION_SCOPE,
  isCommunitySession,
  isInternalSession,
  sessionScopeForTier,
  sessionTierFromScope,
} from "../src/session-tier.ts";
import { hasScope, scopeMatches } from "../src/resource/scope.ts";

test("session tiers map to scope labels", () => {
  assert.equal(sessionScopeForTier("internal"), INTERNAL_SESSION_SCOPE);
  assert.equal(sessionScopeForTier("community"), COMMUNITY_SESSION_SCOPE);
});

test("session tier is derived from scope claims", () => {
  assert.equal(sessionTierFromScope(["internal"]), "internal");
  assert.equal(sessionTierFromScope(["community"]), "community");
  assert.equal(sessionTierFromScope(["ragbot/ConfigService.ListConfig"]), null);
});

test("internal sessions may exchange directly per audience", () => {
  const identity = { scopes: ["internal"] };
  assert.ok(isInternalSession(identity));
  assert.equal(!isCommunitySession(identity), true);
  assert.deepEqual(directExchangeGrants(identity, "ragbot"), ["ragbot/*"]);
});

test("community sessions require a bff actor for direct exchange", () => {
  const identity = { scopes: ["community"] };
  assert.ok(isCommunitySession(identity));
  assert.equal(directExchangeGrants(identity, "ragbot"), null);
});

test("scope matching no longer treats a bare wildcard as universal", () => {
  assert.equal(scopeMatches("*", "ragbot/ConfigService.ListConfig"), false);
  assert.equal(scopeMatches("ragbot/*", "ragbot/ConfigService.ListConfig"), true);
  assert.equal(hasScope({ kind: "user", subject: "u", email: null, scopes: ["internal"], actorChain: [] }, "idp/RegistryService.ListApplications"), true);
  assert.equal(hasScope({ kind: "user", subject: "u", email: null, scopes: ["ragbot/*"], actorChain: [] }, "ragbot/ConfigService.ListConfig"), true);
});
