import { env as testEnv } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { assert, describe, test } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/env";

const CONTROL_TOKEN = "s3cr3t-control-token";
const noopCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

// Stub the DISCORD_GATEWAY binding so the control routes exercise auth + wiring
// without opening a real websocket. Records which RPC the route dispatched.
const stubGatewayEnv = (calls: string[], overrides: Record<string, unknown> = {}): Env =>
  ({
    GATEWAY_CONTROL_TOKEN: CONTROL_TOKEN,
    DISCORD_GATEWAY: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        start: async () => {
          calls.push("start");
          return { ok: true };
        },
        stop: async () => {
          calls.push("stop");
          return { ok: true };
        },
        health: async () => {
          calls.push("health");
          return { connected: true, resumable: false };
        },
      }),
    },
    ...overrides,
  }) as unknown as Env;

const request = (method: string, path: string, token?: string) =>
  new Request(`https://ragbot.jsmunro.me${path}`, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

describe("operator control routes", () => {
  test("a correct token dispatches the matching gateway RPC", async () => {
    const calls: string[] = [];
    const env = stubGatewayEnv(calls);

    const start = await worker.fetch(request("POST", "/gateway/start", CONTROL_TOKEN), env, noopCtx);
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), { ok: true });

    const stop = await worker.fetch(request("POST", "/gateway/stop", CONTROL_TOKEN), env, noopCtx);
    assert.equal(stop.status, 200);

    const health = await worker.fetch(request("GET", "/gateway/health", CONTROL_TOKEN), env, noopCtx);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { connected: true, resumable: false });

    assert.deepEqual(calls, ["start", "stop", "health"]);
  });

  test("a missing token is unauthorized (401) and dispatches nothing", async () => {
    const calls: string[] = [];
    const response = await worker.fetch(request("POST", "/gateway/start"), stubGatewayEnv(calls), noopCtx);
    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
  });

  test("a wrong token is forbidden (403) and dispatches nothing", async () => {
    const calls: string[] = [];
    const response = await worker.fetch(
      request("POST", "/gateway/start", "wrong-token"),
      stubGatewayEnv(calls),
      noopCtx,
    );
    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
  });

  test("an unconfigured control token is unauthorized (401)", async () => {
    const calls: string[] = [];
    const response = await worker.fetch(
      request("POST", "/gateway/start", CONTROL_TOKEN),
      stubGatewayEnv(calls, { GATEWAY_CONTROL_TOKEN: "" }),
      noopCtx,
    );
    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
  });

  test("unknown paths fall through to 404", async () => {
    const response = await worker.fetch(request("GET", "/nope", CONTROL_TOKEN), stubGatewayEnv([]), noopCtx);
    assert.equal(response.status, 404);
  });
});

// The websocket protocol internals keep the DO RPC persistence tests ported from
// the old gateway suite; the fake socket stands in for gateway.discord.gg.
class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

const withFakeWebSocket = async (body: () => Promise<void>) => {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as never;
  try {
    await body();
  } finally {
    globalThis.WebSocket = original;
  }
};

describe("DiscordGateway durable object", () => {
  test("start RPC persists enabled state and schedules an alarm", async () => {
    await withFakeWebSocket(async () => {
      const id = testEnv.DISCORD_GATEWAY.idFromName(`rpc-start-${crypto.randomUUID()}`);
      const gateway = testEnv.DISCORD_GATEWAY.get(id);

      assert.deepEqual(await gateway.health(), { connected: false, resumable: false });
      assert.deepEqual(await gateway.start(), { ok: true });

      await runInDurableObject(gateway, async (_instance, state) => {
        assert.equal(await state.storage.get("gatewayEnabled"), true);
        const alarmTime = await state.storage.getAlarm();
        assert.equal(typeof alarmTime, "number");
        assert.ok((alarmTime ?? 0) > Date.now());
      });
    });
  });

  test("stop RPC disables the gateway and prevents reconnects", async () => {
    await withFakeWebSocket(async () => {
      const id = testEnv.DISCORD_GATEWAY.idFromName(`rpc-stop-${crypto.randomUUID()}`);
      const gateway = testEnv.DISCORD_GATEWAY.get(id);

      await gateway.start();
      assert.equal(FakeWebSocket.instances.length, 1);

      assert.deepEqual(await gateway.stop(), { ok: true });

      await runInDurableObject(gateway, async (instance, state) => {
        assert.equal(await state.storage.get("gatewayEnabled"), undefined);
        assert.isNull(await state.storage.getAlarm(), "stop cancels the watchdog alarm");
        // Even a racing alarm must not reconnect after a stop.
        await (instance as { alarm: () => Promise<void> }).alarm();
        assert.isNull(await state.storage.getAlarm());
      });

      assert.equal(FakeWebSocket.instances.length, 1, "a stopped gateway must not reconnect");
      assert.deepEqual(await gateway.health(), { connected: false, resumable: false });

      assert.deepEqual(await gateway.start(), { ok: true });
      assert.equal(FakeWebSocket.instances.length, 2, "start works again after a stop");
    });
  });

  test("the watchdog alarm prunes processed-message markers older than 24h", async () => {
    await withFakeWebSocket(async () => {
      const id = testEnv.DISCORD_GATEWAY.idFromName(`prune-${crypto.randomUUID()}`);
      const gateway = testEnv.DISCORD_GATEWAY.get(id);

      await runInDurableObject(gateway, async (instance, state) => {
        const now = Date.now();
        await state.storage.put("processed:old-message", now - 25 * 60 * 60_000);
        await state.storage.put("processed:fresh-message", now - 60_000);

        await (instance as { alarm: () => Promise<void> }).alarm();

        assert.equal(await state.storage.get("processed:old-message"), undefined, "stale marker pruned");
        assert.equal(typeof (await state.storage.get("processed:fresh-message")), "number", "fresh marker kept");
      });
    });
  });
});
