import { afterEach, assert, test, vi } from "vitest";

import { handleEgressRequest } from "@rag/egress/server";
import type { EgressEnv as Env, EgressFetchInput, EgressProfileConfig } from "@rag/egress/contracts";

// The egress boundary is now a plain RPC: a caller reachable over the trusted
// EGRESS binding passes an EgressFetchInput. No signing, no envelope, no
// registry — authorization is the profile's allowedCallers list.

const input = (overrides: Partial<EgressFetchInput> = {}): EgressFetchInput => ({
  caller: "responder",
  profile: "discord-rest",
  method: "POST",
  url: "https://discord.com/api/v10/channels/200000000000000001/messages",
  headers: { "content-type": "application/json" },
  ...overrides,
});

const profile = (allowedCallers: string[] = ["responder"]): EgressProfileConfig => ({
  identity: "discord-rest",
  allowedCallers,
  allowedHosts: ["discord.com"],
  credential: { header: "authorization", env: "DISCORD_BOT_TOKEN", prefix: "Bot " },
  timeoutMs: 5000,
  maxResponseBytes: 1024,
});

const egressControl = (profiles: Record<string, EgressProfileConfig>) => ({
  idFromName: (name: string) => name,
  get: () => ({
    getProfile: async (name: string) => profiles[name] ?? null,
    putProfile: async () => undefined,
    snapshot: async () => profiles,
  }),
});

const env = (overrides: Partial<Env> = {}): Env =>
  ({ DISCORD_BOT_TOKEN: "bot-token", ...overrides }) as Env;

const expectReject = async (run: () => Promise<unknown>) => {
  let rejected = false;
  await run().catch(() => {
    rejected = true;
  });
  assert.isTrue(rejected);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test("egress falls back to bundled defaults when no control-plane profile exists", async () => {
  // With no EGRESS_CONTROL binding the bundled DEFAULT_EGRESS_PROFILES are used;
  // an unknown (caller, profile) still fails closed.
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expectReject(async () => handleEgressRequest(env(), input({ profile: "does-not-exist" })));
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("egress fails closed when the requested profile is absent from the control plane", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expectReject(() =>
    handleEgressRequest(env({ EGRESS_CONTROL: egressControl({}) as never }), input({ profile: "custom-x" })),
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("egress denies callers absent from the profile caller list", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expectReject(() =>
    handleEgressRequest(
      env({ EGRESS_CONTROL: egressControl({ "discord-rest": profile(["connectors"]) }) as never }),
      input({ caller: "responder" }),
    ),
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("egress authorizes a configured profile and injects the profile credential", async () => {
  const fetchMock = vi.fn(
    async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await handleEgressRequest(
    env({ EGRESS_CONTROL: egressControl({ "discord-rest": profile() }) as never }),
    input(),
  );

  assert.equal(result.status, 200);
  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0];
  assert.equal(url, "https://discord.com/api/v10/channels/200000000000000001/messages");
  assert.equal((init as RequestInit).method, "POST");
  assert.equal(new Headers((init as RequestInit).headers).get("authorization"), "Bot bot-token");
});
