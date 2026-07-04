import { assert, test } from "vitest";

import { encodeAiSpendJobEnvelope } from "@rag/bot/contracts";
import { processSpendQueueMessage } from "@rag/bot/lib/ai/spend";
import { createEnv, signedServiceMessage } from "../../helpers";

// Command dispatch (rag/raghammer/ragunban/undorag/ragspend) is exercised on the
// all-deferred processor path in session-dispatch.test.ts now that the gateway
// /discord route is retired. This file keeps the spend-aggregation worker test.

test("spend worker aggregates pending spend events", async () => {
  const originalFetch = globalThis.fetch;
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /ai-gateway\/gateways\/platy\/logs/);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer cf-token");
    return Response.json({
      result: [
        {
          metadata: JSON.stringify({ ragbot_request_id: "event-1" }),
          cost: 0.033,
        },
      ],
    });
  };
  try {
    const env = createEnv("unused", {
      CF_ACCOUNT_ID: "account-id",
      CLOUDFLARE_API_TOKEN: "cf-token",
      CF_AIG_GATEWAY_ID: "platy",
      DB: {
        batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
          updates.push(...statements);
        },
        prepare: (sql: string) => {
          const runner = (args: unknown[]) => ({
            sql,
            args,
            first: async () => {
              assert.match(sql, /FROM rag_ai_spend_events/);
              assert.deepEqual(args, ["event-1"]);
              return {
                source_id: "event-1",
                kind: "ask",
                requester_user_id: "user-id",
                requester_username: "Alice",
                model: "grok/grok-4.3",
                prompt_tokens: 1000,
                completion_tokens: 2000,
                total_tokens: 3000,
                unit_count: 0,
                estimated_cost_micros: null,
                status: "pending",
              };
            },
            run: async () => ({ results: [] }),
          });
          return {
            ...runner([]),
            bind: (...args: unknown[]) => runner(args),
          };
        },
      },
    });
    let acked = false;

    await processSpendQueueMessage(
      {
        body: await signedServiceMessage(
          encodeAiSpendJobEnvelope({ spendEventId: "event-1" }, { source: "worker" }),
          { iss: "workflows", aud: "spend", env },
        ),
        attempts: 1,
        ack: () => {
          acked = true;
        },
        retry: () => {
          throw new Error("message should not be retried");
        },
      } as never,
      env,
    );

    assert.equal(acked, true);
    assert.equal(updates.length, 2);
    assert.match(updates[0].sql, /UPDATE rag_ai_spend_events/);
    assert.deepEqual(updates[0].args, [33000, "event-1"]);
    assert.match(updates[1].sql, /INSERT INTO rag_ai_spend_totals/);
    assert.match(updates[1].sql, /SUM\(estimated_cost_micros\)/);
    assert.deepEqual(updates[1].args, ["Alice", "user-id"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
