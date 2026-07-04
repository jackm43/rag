import { assert, test } from "vitest";

import { encodeRegistryInvokeEnvelope } from "@rag/platform/contracts";
import type { Env } from "@rag/platform/contracts";
import type { RegistryApplicationMetadata, RegistryScaffold } from "@rag/platform/lib/registry-kit/types";
import { createServiceRegistryMock, signedServiceMessage } from "../../helpers";
import { handleRegistryInvoke } from "@rag/platform/workers/registry/service_server/src/entrypoint";
import { createRegistryApplication } from "@rag/platform/workers/registry/service_server/src/operations";

test("registry create request stores metadata and scaffold result inline", async () => {
  const applications = new Map<string, RegistryApplicationMetadata>();
  const scaffolds = new Map<string, RegistryScaffold>();
  const registry = {
    create: async (input: RegistryApplicationMetadata) => {
      const metadata: RegistryApplicationMetadata = {
        ...input,
        requestedAt: "2026-07-04T00:00:00.000Z",
        status: "requested",
      };
      applications.set(metadata.id, metadata);
      return metadata;
    },
    get: async (id: string) => applications.get(id) ?? null,
    list: async () => [...applications.values()],
    update: async () => null,
    remove: async () => null,
    putScaffoldResult: async (applicationId: string, result: RegistryScaffold) => {
      scaffolds.set(applicationId, result);
      const existing = applications.get(applicationId);
      if (existing) {
        applications.set(applicationId, { ...existing, status: "scaffolded" });
      }
    },
    getScaffoldResult: async (applicationId: string) => scaffolds.get(applicationId) ?? null,
  };
  const env = {
    REGISTRY_APPLICATIONS: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => registry,
    },
    REGISTRY_GITHUB_OWNER: "jackm",
    REGISTRY_GITHUB_REPO: "rag",
  } as unknown as Env;

  const response = await createRegistryApplication(
    env,
    { discordId: "123456789012345678", accessSub: "access-sub" },
    {
      id: "sample-app",
      displayName: "Sample App",
      zone: "application",
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
    },
  );

  assert.equal(response.application.id, "sample-app");
  assert.equal(response.scaffold.applicationId, "sample-app");
  assert.isAtLeast(response.scaffold.artifacts.length, 1);
  assert.equal(scaffolds.get("sample-app")?.applicationId, "sample-app");
  assert.equal(applications.get("sample-app")?.status, "scaffolded");
});

test("registry service invoke verifies service boundary before dispatch", async () => {
  const applications = new Map<string, RegistryApplicationMetadata>([
    [
      "sample-app",
      {
        id: "sample-app",
        displayName: "Sample App",
        zone: "application",
        targets: ["workflows"],
        operations: ["sample.invoke"],
        routes: [],
        ownerDiscordId: "123456789012345678",
        ownerAccessSub: "access-sub",
        requestedAt: "2026-07-04T00:00:00.000Z",
        status: "requested",
      },
    ],
  ]);
  const registry = {
    create: async () => {
      throw new Error("create should not be used");
    },
    get: async (id: string) => applications.get(id) ?? null,
    list: async () => [...applications.values()],
    update: async () => null,
    remove: async () => null,
    putScaffoldResult: async () => undefined,
    getScaffoldResult: async () => null,
  };
  const env = {
    SERVICE_REGISTRY: createServiceRegistryMock(),
    REGISTRY_APPLICATIONS: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => registry,
    },
  } as unknown as Env;
  const envelope = encodeRegistryInvokeEnvelope(
    {
      kind: "registry.invoke",
      operation: "application.get",
      actorJson: JSON.stringify({ discordId: "123456789012345678", accessSub: "access-sub" }),
      bodyJson: "{}",
      targetId: "sample-app",
    },
    { source: "worker" },
  );

  const accepted = await handleRegistryInvoke(
    env,
    await signedServiceMessage(envelope, { iss: "registry", aud: "registry", sub: "123456789012345678", env }),
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { application: applications.get("sample-app") });

  const denied = await handleRegistryInvoke(
    env,
    await signedServiceMessage(envelope, { iss: "gateway", aud: "registry", sub: "123456789012345678" }),
  );
  assert.equal(denied.status, 403);
});
