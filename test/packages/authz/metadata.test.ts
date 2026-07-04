import { assert, test } from "vitest";

import {
  authorizationMetadataToEntities,
  authorizeWithMetadata,
} from "../../../packages/authz/metadata.ts";
import { authorize } from "../../../packages/authz/authorize.ts";

const metadataPayload = {
  authorizationShape: {
    application: {
      id: "demo",
      zone: "application",
      targets: [],
      operations: ["demo.read"],
      attestations: {
        productionReady: true,
        repository: "jackm/rag",
      },
    },
  },
  applications: [
    {
      id: "gateway",
      zone: "platform",
      targets: ["demo"],
      operations: [],
    },
    {
      id: "demo",
      zone: "application",
      targets: [],
      operations: ["demo.read"],
    },
  ],
};

test("authorization metadata converts application shape into Cedar entities", () => {
  const entities = authorizationMetadataToEntities(
    metadataPayload.authorizationShape,
    metadataPayload.applications,
  );

  assert.isTrue(
    authorize(
      {
        principal: { type: "Application", id: "gateway" },
        action: "service.exchange",
        resource: { type: "Application", id: "demo" },
        context: { fromZone: "platform", toZone: "application" },
      },
      entities,
    ).allowed,
  );
  assert.isTrue(
    authorize(
      {
        principal: { type: "Application", id: "gateway" },
        action: "service.invoke",
        resource: { type: "Service", id: "demo:demo.read" },
        context: { operation: "demo.read" },
      },
      entities,
    ).allowed,
  );

  const demo = entities.find((entity) => entity.uid.id === "demo");
  assert.equal(demo?.attrs.productionReady, true);
  assert.equal(demo?.attrs.attestationRepository, "jackm/rag");
});

test("authorizeWithMetadata fetches metadata GraphQL before evaluating", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return Response.json({ data: metadataPayload });
  };

  const decision = await authorizeWithMetadata(
    {
      principal: { type: "Application", id: "gateway" },
      action: "service.invoke",
      resource: { type: "Service", id: "demo:demo.read" },
      context: { operation: "demo.read" },
    },
    {
      metadata: {
        endpoint: "https://metadata.jsmunro.me",
        token: "metadata-token",
        fetcher,
      },
    },
  );

  assert.isTrue(decision.allowed);
  assert.lengthOf(calls, 1);
  assert.equal(calls[0].url, "https://metadata.jsmunro.me/graphql");
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer metadata-token");
  assert.include(String(calls[0].init?.body), "\"id\":\"demo\"");
});
