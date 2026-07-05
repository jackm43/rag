import { assert, test } from "vitest";
import nacl from "tweetnacl";

import worker from "@rag/webhooks/src";
import { createEnv, createSignedRequest } from "../../helpers";

// The platform Discord-interactions ingress (webhooks.jsmunro.me/{clientId}/
// interactions). It verifies the Ed25519 signature against the app's public
// key, answers Discord's PING probe with type-1, and for every real
// interaction returns the type-5 deferred ack and kicks the InteractionSession
// DO — carrying NO bot domain code. These prove the neutral contract: verify ->
// ack -> kick, and fail closed on a bad signature or unknown app.

const CLIENT_ID = "app-123";
const hex = (key: Uint8Array) => Buffer.from(key).toString("hex");

const setup = (overrides: Record<string, unknown> = {}) => {
  const keyPair = nacl.sign.keyPair();
  const kicked: Array<{ id: unknown; interaction: { token?: string } }> = [];
  const env = createEnv(hex(keyPair.publicKey), {
    DISCORD_INTERACTION_PUBLIC_KEYS: JSON.stringify({ [CLIENT_ID]: hex(keyPair.publicKey) }),
    INTERACTION_SESSION: {
      idFromName: (name: string) => ({ name }),
      get: (id: unknown) => ({
        run: async (interaction: { token?: string }) => {
          kicked.push({ id, interaction });
        },
      }),
    },
    ...overrides,
  });
  return { keyPair, kicked, env };
};

const fetchWith = async (env: unknown, request: Request): Promise<Response> => {
  const promises: Promise<unknown>[] = [];
  const response = await worker.fetch(request, env as never, {
    waitUntil: (promise: Promise<unknown>) => promises.push(promise),
  } as never);
  await Promise.all(promises);
  return response;
};

test("a signed PING is answered with type-1 and never kicks the DO", async () => {
  const { keyPair, kicked, env } = setup();
  const response = await fetchWith(
    env,
    createSignedRequest({ type: 1 }, keyPair.secretKey, `/${CLIENT_ID}/interactions`),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 1 });
  assert.equal(kicked.length, 0);
});

test("a verified command returns the type-5 ack and kicks the DO keyed by token", async () => {
  const { keyPair, kicked, env } = setup();
  const response = await fetchWith(
    env,
    createSignedRequest(
      {
        type: 2,
        application_id: "application-id",
        token: "interaction-token",
        data: { name: "ragspend" },
        member: { user: { id: "1", username: "alice" } },
      },
      keyPair.secretKey,
      `/${CLIENT_ID}/interactions`,
    ),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 5 });
  assert.equal(kicked.length, 1);
  assert.equal(kicked[0].interaction.token, "interaction-token");
  // Keyed idFromName(interactionToken) so retries of the same interaction
  // address the same DO.
  assert.deepEqual(kicked[0].id, { name: "interaction-token" });
});

test("a signature from the wrong key fails closed with 401 and no kick", async () => {
  const { kicked, env } = setup();
  const wrongKey = nacl.sign.keyPair();
  const response = await fetchWith(
    env,
    createSignedRequest(
      { type: 2, token: "interaction-token", data: { name: "ragspend" } },
      wrongKey.secretKey,
      `/${CLIENT_ID}/interactions`,
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(kicked.length, 0);
});

test("an unregistered client id 404s before any verification", async () => {
  const { keyPair, kicked, env } = setup();
  const response = await fetchWith(
    env,
    createSignedRequest({ type: 1 }, keyPair.secretKey, "/unregistered-app/interactions"),
  );

  assert.equal(response.status, 404);
  assert.equal(kicked.length, 0);
});
