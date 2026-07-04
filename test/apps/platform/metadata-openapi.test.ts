import { assert, test } from "vitest";

import { decodeMetadataQueryEnvelope } from "@rag/platform/contracts";
import { serviceEnvelopeBytes } from "@rag/service-kit/message";
import worker from "@rag/platform/workers/metadata/api/middleware_client/src";
import type { Env } from "@rag/platform/contracts";
import { createEnv } from "../../helpers";

test("metadata worker serves generated OpenAPI document", async () => {
  const response = await worker.fetch(
    new Request("https://metadata.example.com/openapi.json", { method: "GET" }),
    {} as Env,
    { waitUntil: () => undefined } as never,
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    openapi?: string;
    paths?: Record<string, unknown>;
  };
  assert.equal(body.openapi, "3.1.0");
  assert.containsAllKeys(body.paths ?? {}, ["/openapi.json", "/graphql"]);
});

test("metadata GraphQL route invokes metadata service binding", async () => {
  let invoked = false;
  let query: string | undefined;
  const env = createEnv("", {
    METADATA_QUERY_TOKEN: "query-token",
    METADATA_SERVICE: {
      invoke: async (message: Uint8Array) => {
        invoked = true;
        const envelope = serviceEnvelopeBytes(message);
        const decoded = decodeMetadataQueryEnvelope(envelope);
        query = decoded?.query;
        return { status: 200, body: { data: { ok: true } } };
      },
    },
  }) as Env;
  const response = await worker.fetch(
    new Request("https://metadata.example.com/graphql", {
      method: "POST",
      headers: {
        authorization: "Bearer query-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "{ applications { id } }" }),
    }),
    env,
    { waitUntil: () => undefined } as never,
  );

  assert.equal(response.status, 200);
  assert.isTrue(invoked);
  assert.equal(query, "{ applications { id } }");
});
