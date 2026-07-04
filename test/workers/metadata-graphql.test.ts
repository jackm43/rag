import { assert, test } from "vitest";

import { encodeMetadataQueryEnvelope } from "../../packages/contracts";
import type { Env } from "../../packages/contracts/types";
import { createServiceRegistryMock, signedServiceMessage } from "../helpers";
import { executeMetadataGraphQl, handleMetadataQuery } from "../../workers/applications/metadata/service_server/src";

const createMetadataEnv = () => ({
  SERVICE_REGISTRY: createServiceRegistryMock(),
  REGISTRY_GITHUB_OWNER: "jackm",
  REGISTRY_GITHUB_REPO: "rag",
  REGISTRY_APPLICATIONS: {
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({
      get: async (id: string) => id === "sample-app"
        ? {
          id: "sample-app",
          displayName: "Sample App",
          ownerDiscordId: "123",
          ownerAccessSub: "access-sub",
          zone: "application",
          requestedAt: "2026-01-01T00:00:00.000Z",
          status: "scaffolded",
          targets: ["workflows"],
          operations: ["sample.invoke"],
          routes: [
            {
              method: "POST",
              path: "/sample",
              operationId: "sampleInvoke",
              serviceOperation: "sample.invoke",
            },
          ],
        }
        : null,
      list: async () => [],
      create: async () => undefined,
      update: async () => null,
      remove: async () => null,
      putScaffoldResult: async () => undefined,
      getScaffoldResult: async () => ({
        artifacts: [
          {
            path: "registry/applications/sample-app.yaml",
            sha256: "abc123",
            content: "id: sample-app\n",
          },
        ],
      }),
    }),
  },
  ATTESTATIONS: {
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({
      record: async () => undefined,
      list: async () => [],
      verifyArtifact: async () => ({ ok: true, scope: "production" }),
      seenDelivery: async () => true,
    }),
  },
}) as unknown as Env;

test("metadata service resolver builds authorization shape with attestation state", async () => {
  const env = createMetadataEnv();

  const response = await executeMetadataGraphQl(
    {
      query: "query($id: String!) { authorizationShape(id: $id) { service application } }",
      variables: { id: "sample-app", includeAttestations: true },
    },
    env,
  );

  const shape = response.data?.authorizationShape as Record<string, unknown> | undefined;
  assert.isOk(shape);
  assert.deepInclude(shape.service as Record<string, unknown>, {
    service: "sample-app",
    zone: "application",
  });
  const application = shape.application as Record<string, unknown>;
  const attestations = application.attestations as { productionReady?: boolean };
  assert.equal(attestations.productionReady, true);
});

test("metadata service invoke verifies service boundary before resolver dispatch", async () => {
  const env = createMetadataEnv();
  const envelope = encodeMetadataQueryEnvelope(
    {
      kind: "metadata.query",
      query: "query($id: String!) { authorizationShape(id: $id) { service application } }",
      variablesJson: JSON.stringify({ id: "sample-app", includeAttestations: true }),
    },
    { source: "worker" },
  );

  const accepted = await handleMetadataQuery(
    env,
    await signedServiceMessage(envelope, { iss: "metadata", aud: "metadata", sub: "metadata-query", env }),
  );
  assert.equal(accepted.status, 200);
  const shape = (accepted.body as { data?: Record<string, unknown> }).data?.authorizationShape as Record<string, unknown>;
  assert.deepInclude(shape.service as Record<string, unknown>, {
    service: "sample-app",
    zone: "application",
  });

  const denied = await handleMetadataQuery(
    env,
    await signedServiceMessage(envelope, { iss: "gateway", aud: "metadata", sub: "metadata-query" }),
  );
  assert.equal(denied.status, 403);
});
