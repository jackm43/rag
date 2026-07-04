import { assert, test } from "vitest";

import { createGatewayRouter } from "@rag/bot/workers/gateway/api/middleware_client/src/router";
import { GATEWAY_ROUTES } from "@rag/bot/workers/gateway/api/middleware_client/src/routes";

const ok = async () => new Response("ok");

const allHandlers = () =>
  Object.fromEntries(
    Object.values(GATEWAY_ROUTES).flatMap((routes) =>
      routes.map((route) => [route.operationId, ok]),
    ),
  );

test("the router is constructed from the OpenAPI route table and fails closed on missing handlers", () => {
  // Every spec operation implemented: construction succeeds.
  assert.ok(createGatewayRouter(allHandlers()));

  // A spec operation without a handler cannot construct (and so cannot deploy).
  const incomplete = allHandlers();
  delete incomplete.startGateway;
  assert.throws(() => createGatewayRouter(incomplete), /startGateway/);
});

test("paths and methods outside the spec are refused with the spec's Allow set", async () => {
  const router = createGatewayRouter(allHandlers());
  const env = {} as never;
  const ctx = { waitUntil: () => undefined } as never;

  const unknownPath = await router.handle(
    new Request("https://example.com/nope", { method: "GET" }),
    env,
    ctx,
  );
  assert.equal(unknownPath.status, 404);

  const wrongMethod = await router.handle(
    new Request("https://example.com/gateway/start", { method: "DELETE" }),
    env,
    ctx,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("Allow"), "POST");
});
