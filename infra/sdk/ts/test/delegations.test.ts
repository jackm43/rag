import test from "node:test";
import assert from "node:assert/strict";

import {
  actorChainRefusal,
  applicationFromClientId,
  delegationGraph,
  delegationGraphFromDiscovery,
  type Identity,
} from "../src/index.ts";

const identity = (overrides: Partial<Identity>): Identity => ({
  kind: "user",
  subject: "user@example.com",
  email: "user@example.com",
  scopes: [],
  actorChain: [],
  ...overrides,
});

const discovery = {
  applications: [
    { name: "deploy", delegations: [{ audience: "cloudflare", scopes: ["cloudflare/WorkersService.*"] }] },
    { name: "cloudflare", delegations: [] },
    { name: "aigateway", delegations: [{ audience: "ragbot", scopes: [] }] },
    { name: "ragbot", delegations: [{ audience: "aigateway", scopes: [] }] },
    { name: "chat", delegations: [{ audience: "aigateway", scopes: [] }, { audience: "idp", scopes: [] }] },
  ],
};

const graph = delegationGraphFromDiscovery(discovery);

test("applicationFromClientId parses gateway-minted service client ids", () => {
  assert.equal(applicationFromClientId("svc_deploy_a1b2c3"), "deploy");
  assert.equal(applicationFromClientId("svc_auth-gateway_xyz"), "auth-gateway");
  assert.equal(applicationFromClientId("not_a_service"), null);
  assert.equal(applicationFromClientId("svc_"), null);
  assert.equal(applicationFromClientId("svc_x"), null);
});

test("empty actor chain is always valid", () => {
  assert.equal(actorChainRefusal(identity({}), "cloudflare", graph), null);
});

test("single-hop chain requires a delegation to the token audience", () => {
  const chained = identity({
    actorChain: ["svc_deploy_abc"],
    scopes: ["cloudflare/WorkersService.ListWorkers"],
  });
  assert.equal(actorChainRefusal(chained, "cloudflare", graph), null);

  const wrongAudience = actorChainRefusal(chained, "ragbot", graph);
  assert.match(wrongAudience ?? "", /no delegation to audience ragbot/);
});

test("delegation scopes must cover the token scopes", () => {
  const overScoped = identity({
    actorChain: ["svc_deploy_abc"],
    scopes: ["cloudflare/DnsService.DeleteZone"],
  });
  const refusal = actorChainRefusal(overScoped, "cloudflare", graph);
  assert.match(refusal ?? "", /does not grant cloudflare\/DnsService.DeleteZone/);
});

test("unknown actors in the chain are refused", () => {
  const unknown = identity({ actorChain: ["svc_rogue_abc"], scopes: [] });
  assert.match(actorChainRefusal(unknown, "cloudflare", graph) ?? "", /unknown actor/);

  const malformed = identity({ actorChain: ["rogue"], scopes: [] });
  assert.match(actorChainRefusal(malformed, "cloudflare", graph) ?? "", /unknown actor/);
});

test("multi-hop chains validate every pairwise delegation", () => {
  // chat -> aigateway -> ragbot: aigateway minted the ragbot token (hop 0),
  // chat minted the aigateway token aigateway consumed (hop 1).
  const valid = identity({
    actorChain: ["svc_aigateway_a", "svc_chat_b"],
    scopes: ["ragbot/LeaderboardService.ListTotals"],
  });
  assert.equal(actorChainRefusal(valid, "ragbot", graph), null);

  // deploy never holds a delegation to aigateway, so it cannot appear as the
  // deeper hop that produced aigateway's inbound token.
  const broken = identity({
    actorChain: ["svc_aigateway_a", "svc_deploy_b"],
    scopes: ["ragbot/LeaderboardService.ListTotals"],
  });
  assert.match(actorChainRefusal(broken, "ragbot", graph) ?? "", /no delegation covering its position/);
});

test("deeper hops may have consumed a gateway session token (aud idp)", () => {
  // bff holds only an idp delegation: it exchanged the user's session token
  // (aud idp) rather than a token addressed to its successor's application.
  const sessionGraph = delegationGraphFromDiscovery({
    applications: [
      { name: "aigateway", delegations: [{ audience: "ragbot", scopes: [] }] },
      { name: "ragbot", delegations: [] },
      { name: "bff", delegations: [{ audience: "idp", scopes: [] }] },
    ],
  });
  const viaSession = identity({
    actorChain: ["svc_aigateway_a", "svc_bff_b"],
    scopes: [],
  });
  assert.equal(actorChainRefusal(viaSession, "ragbot", sessionGraph), null);
});

test("delegationGraph caches per issuer and serves stale on fetch failure", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls > 1) {
      throw new Error("network down");
    }
    return new Response(JSON.stringify(discovery), { status: 200 });
  };

  const first = await delegationGraph("https://gw.test", fetchImpl);
  assert.ok(first?.has("deploy"));
  const second = await delegationGraph("https://gw.test", fetchImpl);
  assert.equal(second, first);
  assert.equal(calls, 1);

  const failed = await delegationGraph("https://gw-other.test", fetchImpl);
  assert.equal(failed, null);
});
