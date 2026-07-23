import { env } from "cloudflare:test";
import { assert, beforeEach, test } from "vitest";

import { reconcileAiSpend } from "../src/lib/ai/reconcile";
import type { Env } from "../src/env";

const ALICE_ID = "400000000000000001";
const BOB_ID = "400000000000000002";

type Call = { url: string; init?: RequestInit };

const baseEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    DB: env.DB,
    CF_ACCOUNT_ID: "account-id",
    CF_AIG_GATEWAY_ID: "platy",
    CLOUDFLARE_API_TOKEN: "cf-token",
    ...overrides,
  }) as unknown as Env;

const insertPending = (sourceId: string, userId: string, username: string) =>
  env.DB.prepare(
    "INSERT INTO rag_ai_spend_events (source_id, kind, requester_user_id, requester_username, model, status) VALUES (?, 'channel_reply', ?, ?, 'grok/grok-4.3', 'pending')",
  )
    .bind(sourceId, userId, username)
    .run();

const withFetch = async (
  route: (call: Call) => Response | undefined,
  body: (calls: Call[]) => Promise<void>,
) => {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return route(call) ?? new Response("{}", { status: 200 });
  };
  try {
    await body(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rag_ai_spend_events"),
    env.DB.prepare("DELETE FROM rag_ai_spend_totals"),
  ]);
});

test("reconciles pending spend events against AI Gateway logs and upserts the user total", async () => {
  await insertPending("aigreq:alice-1", ALICE_ID, "alice");

  await withFetch(
    (call) => {
      if (call.url.includes("/ai-gateway/gateways/platy/logs")) {
        // The CF API is called with the account API token.
        assert.equal(
          (call.init?.headers as Record<string, string>)?.authorization,
          "Bearer cf-token",
        );
        return Response.json({
          result: [{ metadata: { ragbot_request_id: "aigreq:alice-1" }, cost: 0.0005 }],
        });
      }
      return undefined;
    },
    async () => {
      const summary = await reconcileAiSpend(baseEnv());
      assert.deepEqual(summary, { reconciled: 1, scanned: 1 });
    },
  );

  const event = await env.DB.prepare(
    "SELECT status, estimated_cost_micros FROM rag_ai_spend_events WHERE source_id = ?",
  )
    .bind("aigreq:alice-1")
    .first<{ status: string; estimated_cost_micros: number }>();
  assert.equal(event?.status, "aggregated");
  assert.equal(event?.estimated_cost_micros, 500);

  const total = await env.DB.prepare(
    "SELECT estimated_cost_micros, event_count FROM rag_ai_spend_totals WHERE requester_user_id = ?",
  )
    .bind(ALICE_ID)
    .first<{ estimated_cost_micros: number; event_count: number }>();
  assert.equal(total?.estimated_cost_micros, 500);
  assert.equal(total?.event_count, 1);
});

test("leaves events without a matching log pending for a later sweep", async () => {
  await insertPending("aigreq:bob-1", BOB_ID, "bob");

  await withFetch(
    (call) =>
      call.url.includes("/ai-gateway/gateways/platy/logs")
        ? Response.json({ result: [{ metadata: { ragbot_request_id: "someone-else" }, cost: 0.01 }] })
        : undefined,
    async () => {
      const summary = await reconcileAiSpend(baseEnv());
      assert.deepEqual(summary, { reconciled: 0, scanned: 1 });
    },
  );

  const event = await env.DB.prepare("SELECT status FROM rag_ai_spend_events WHERE source_id = ?")
    .bind("aigreq:bob-1")
    .first<{ status: string }>();
  assert.equal(event?.status, "pending");

  const total = await env.DB.prepare("SELECT requester_user_id FROM rag_ai_spend_totals WHERE requester_user_id = ?")
    .bind(BOB_ID)
    .first();
  assert.equal(total, null);
});

test("continues the sweep past an unmatched event and reconciles later rows", async () => {
  await insertPending("aigreq:err-1", ALICE_ID, "alice");
  await insertPending("aigreq:ok-2", BOB_ID, "bob");

  await withFetch(
    (call) => {
      // Only ok-2 has a matching log; err-1 finds no match and must stay pending
      // without aborting the sweep before ok-2 is reached.
      if (call.url.includes("/ai-gateway/gateways/platy/logs")) {
        return Response.json({
          result: [{ metadata: { ragbot_request_id: "aigreq:ok-2" }, cost: 0.002 }],
        });
      }
      return undefined;
    },
    async () => {
      const summary = await reconcileAiSpend(baseEnv());
      assert.equal(summary.scanned, 2);
      assert.equal(summary.reconciled, 1);
    },
  );

  const err = await env.DB.prepare("SELECT status FROM rag_ai_spend_events WHERE source_id = ?")
    .bind("aigreq:err-1")
    .first<{ status: string }>();
  assert.equal(err?.status, "pending");
  const ok = await env.DB.prepare("SELECT status, estimated_cost_micros FROM rag_ai_spend_events WHERE source_id = ?")
    .bind("aigreq:ok-2")
    .first<{ status: string; estimated_cost_micros: number }>();
  assert.equal(ok?.status, "aggregated");
  assert.equal(ok?.estimated_cost_micros, 2000);
});
