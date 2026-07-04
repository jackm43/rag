import { afterEach, assert, test, vi } from "vitest";

import { handleEgressRequest } from "../../../packages/egress/server.ts";
import { encodeEgressRequestEnvelope, encodeManifestSnapshot } from "../../../packages/contracts/index.ts";
import type { Env, EgressProfileConfig, ServiceMessageBytes } from "../../../packages/contracts/types.ts";
import { createServiceRegistryMock, signedServiceMessage } from "../../helpers.ts";

const egressEnvelope = () =>
  encodeEgressRequestEnvelope(
    {
      kind: "egress.request",
      profile: "discord-rest",
      method: "POST",
      url: "https://discord.com/api/v10/channels/200000000000000001/messages",
      headersJson: JSON.stringify({ "content-type": "application/json" }),
    },
    { source: "worker" },
  );

const serviceRegistry = () => ({
  idFromName: (name: string) => name,
  get: () => ({
    register: async () => undefined,
    snapshot: async () =>
      encodeManifestSnapshot([
        {
          service: "responder",
          zone: "application",
          targets: [],
          operations: [],
          scopes: [],
        },
        {
          service: "egress",
          zone: "platform",
          targets: [],
          operations: ["egress.request"],
          scopes: [],
        },
      ]),
  }),
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
  ({
    DISCORD_BOT_TOKEN: "bot-token",
    SERVICE_REGISTRY: serviceRegistry(),
    ...overrides,
  }) as Env;

const message = (
  envelope: Uint8Array = egressEnvelope(),
  hopEnv?: Env,
): Promise<ServiceMessageBytes> =>
  signedServiceMessage(envelope, { iss: "responder", aud: "egress", sub: "user-1", env: hopEnv });

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

test("egress fails closed when the control-plane binding is absent", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await expectReject(async () => handleEgressRequest(env(), await message()));
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("egress fails closed when the requested profile is absent", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await expectReject(() =>
    message().then((body) => handleEgressRequest(env({ EGRESS_CONTROL: egressControl({}) as never }), body)),
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("egress denies callers absent from the profile caller list", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await expectReject(() =>
    message().then((body) =>
      handleEgressRequest(
        env({ EGRESS_CONTROL: egressControl({ "discord-rest": profile(["connectors"]) }) as never }),
        body,
      ),
    ),
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("egress authorizes a configured profile and injects the profile credential", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);

  // Unlike the fail-closed tests above (which use the register+snapshot-only
  // registry double), this test exercises a real accept path end to end, so
  // it needs a SERVICE_REGISTRY stub that actually implements the placement
  // RPCs — otherwise the request is (correctly, per the fail-closed
  // doctrine) denied before it ever reaches the profile/credential logic.
  const workingEnv = env({
    SERVICE_REGISTRY: createServiceRegistryMock(),
    EGRESS_CONTROL: egressControl({ "discord-rest": profile() }) as never,
  });

  const result = await handleEgressRequest(workingEnv, await message(undefined, workingEnv));

  assert.equal(result.status, 200);
  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0];
  assert.equal(url, "https://discord.com/api/v10/channels/200000000000000001/messages");
  assert.equal((init as RequestInit).method, "POST");
  assert.equal(new Headers((init as RequestInit).headers).get("authorization"), "Bot bot-token");
});
