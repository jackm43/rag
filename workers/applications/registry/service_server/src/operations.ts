import { verifyArtifactAttestation } from "../../../../../packages/attest/client";
import type { Env } from "../../../../../packages/contracts/types";
import { REGISTRY_APPLICATION_ID_PATTERN, type RegistryApplicationMetadata, type RegistryEvent } from "../../../../../packages/registry/types";
import { processRegistryRequest } from "./processor";

export type RegistryActor = {
  discordId: string;
  accessSub: string;
  email?: string;
};

const applicationRegistry = (env: Env) => {
  if (!env.REGISTRY_APPLICATIONS) {
    throw new Error("registry_unbound");
  }
  return env.REGISTRY_APPLICATIONS.get(env.REGISTRY_APPLICATIONS.idFromName("applications"));
};

const registryEvent = (
  kind: RegistryEvent["kind"],
  metadata: RegistryApplicationMetadata,
): RegistryEvent => ({
  id: crypto.randomUUID(),
  kind,
  applicationId: metadata.id,
  actorDiscordId: metadata.ownerDiscordId,
  actorAccessSub: metadata.ownerAccessSub,
  occurredAt: new Date().toISOString(),
  metadata,
});

export const listRegistryApplications = async (env: Env) => ({
  applications: await applicationRegistry(env).list(),
});

export const createRegistryApplication = async (
  env: Env,
  actor: RegistryActor,
  body: unknown,
) => {
  const application = await applicationRegistry(env).create({
    ...(typeof body === "object" && body !== null ? body : {}),
    ownerDiscordId: actor.discordId,
    ownerAccessSub: actor.accessSub,
  }) as RegistryApplicationMetadata;
  const scaffold = await processRegistryRequest(env, registryEvent("application.create_requested", application));
  return { application, scaffold };
};

export const getRegistryApplication = async (env: Env, id: string) => ({
  application: await applicationRegistry(env).get(id),
});

export const updateRegistryApplication = async (
  env: Env,
  actor: RegistryActor,
  id: string,
  body: unknown,
) => {
  const application = await applicationRegistry(env).update(id, {
    ...(typeof body === "object" && body !== null ? body : {}),
    ownerDiscordId: actor.discordId,
    ownerAccessSub: actor.accessSub,
  }) as RegistryApplicationMetadata | null;
  if (!application) {
    return { application: null, scaffold: null };
  }
  const scaffold = await processRegistryRequest(env, registryEvent("application.update_requested", application));
  return { application, scaffold };
};

export const deleteRegistryApplication = async (
  env: Env,
  actor: RegistryActor,
  id: string,
) => ({
  application: await applicationRegistry(env).remove(id, actor),
});

export const verifyRegistryApplicationAttestations = async (env: Env, id: string) => {
  if (!REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
    return null;
  }
  const registry = applicationRegistry(env);
  const scaffold = await registry.getScaffoldResult(id);
  if (!scaffold || typeof scaffold !== "object" || !Array.isArray((scaffold as { artifacts?: unknown }).artifacts)) {
    return null;
  }
  const repository = `${env.REGISTRY_GITHUB_OWNER ?? "jackm"}/${env.REGISTRY_GITHUB_REPO ?? "rag"}`;
  const artifacts = await Promise.all((scaffold as { artifacts: Array<{ path?: unknown; sha256?: unknown }> }).artifacts
    .filter((artifact) => typeof artifact.path === "string" && typeof artifact.sha256 === "string")
    .map(async (artifact) => ({
      path: artifact.path as string,
      sha256: artifact.sha256 as string,
      attestation: await verifyArtifactAttestation(env, {
        repository,
        path: artifact.path as string,
        sha256: artifact.sha256 as string,
        productionOnly: true,
      }),
    })));
  return {
    applicationId: id,
    repository,
    productionReady: artifacts.length > 0 && artifacts.every((artifact) => artifact.attestation.ok),
    artifacts,
  };
};
