import { query, baseEnv, clearTables, withFetch } from "./helpers";
import { env } from "cloudflare:test";
import { assert, beforeEach, test } from "vitest";
import { reconcileAiSpend } from "../src/lib/ai/reconcile";

const ALICE_ID = "400000000000000001";
const BOB_ID = "400000000000000002";
const log = (id: string, cost: number | string, encoded = false) => ({
  metadata: encoded ? JSON.stringify({ ragbot_request_id: id }) : { ragbot_request_id: id }, cost,
});
beforeEach(() => clearTables("rag_ai_spend_events", "rag_ai_spend_totals"));

test.each([
  {
    name: "reconciles pending spend events against AI Gateway logs and upserts the user total",
    pending: [["aigreq:alice-1", ALICE_ID, "alice"]],
    logs: [log("aigreq:alice-1", 0.0005)], reconciled: 1,
    events: [["aigreq:alice-1", 500]], totals: [[ALICE_ID, 500, 1]],
  },
  {
    name: "leaves events without a matching log pending for a later sweep",
    pending: [["aigreq:bob-1", BOB_ID, "bob"]],
    logs: [log("someone-else", 0.01)], reconciled: 0,
    events: [["aigreq:bob-1", null]], totals: [[BOB_ID, null, 0]],
  },
  {
    name: "fetches the AI Gateway log window once per sweep, not once per pending event",
    pending: [["aigreq:a", ALICE_ID, "alice"], ["aigreq:b", BOB_ID, "bob"], ["aigreq:c", ALICE_ID, "alice"]],
    logs: [log("aigreq:a", 0.001), log("aigreq:c", "0.003", true)], reconciled: 2,
    events: [["aigreq:a", 1000], ["aigreq:b", null], ["aigreq:c", 3000]], totals: [],
  },
  {
    name: "continues the sweep past an unmatched event and reconciles later rows",
    pending: [["aigreq:err-1", ALICE_ID, "alice"], ["aigreq:ok-2", BOB_ID, "bob"]],
    logs: [log("aigreq:ok-2", 0.002)], reconciled: 1,
    events: [["aigreq:err-1", null], ["aigreq:ok-2", 2000]], totals: [],
  },
].map(row => [row.name, row] as const))("%s", async (_, { pending, logs, reconciled, events, totals }) => {
  for (const row of pending) {
    await query("INSERT INTO rag_ai_spend_events (source_id, kind, requester_user_id, requester_username, model, status) VALUES (?, 'channel_reply', ?, ?, 'grok/grok-4.3', 'pending')", ...row).run();
  }
  await withFetch(call => {
    if (!call.url.includes("/ai-gateway/gateways/platy/logs")) return undefined;
    assert.equal(new Headers(call.init?.headers).get("authorization"), "Bearer cf-token");
    return Response.json({ result: logs });
  }, async calls => {
    const summary = await reconcileAiSpend(baseEnv({ CLOUDFLARE_API_TOKEN: "cf-token" }));
    assert.deepEqual(summary, { reconciled, scanned: pending.length });
    assert.equal(calls.filter(call => call.url.includes("/logs")).length, 1, "one log fetch for the sweep");
  });
  for (const [id, cost] of events) {
    const event = await query("SELECT status, estimated_cost_micros FROM rag_ai_spend_events WHERE source_id = ?", id).first<{ status: string; estimated_cost_micros: number }>();
    assert.equal(event?.status, cost === null ? "pending" : "aggregated");
    if (cost !== null) assert.equal(event?.estimated_cost_micros, cost);
  }
  for (const [id, cost, count] of totals) {
    const total = await query("SELECT estimated_cost_micros, event_count FROM rag_ai_spend_totals WHERE requester_user_id = ?", id).first();
    assert.deepEqual(total, cost === null ? null : { estimated_cost_micros: cost, event_count: count });
  }
});
