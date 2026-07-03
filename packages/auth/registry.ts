import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { errorMessage, logger } from "../logger";
import { decodeManifestSnapshot, encodeServiceManifest } from "../contracts";
import type { Env } from "../contracts/types";
import { isServiceManifest, manifestsToEntities, type ServiceManifest } from "./manifest";

// Client side of the service registry: workers register their manifest with
// the ServiceRegistry Durable Object (hosted by the gateway, the parent
// application) and the authorizer consumes the registry's Cedar entity
// snapshot. Both RPC payloads are capnp bytes (service.capnp); the entity
// derivation happens here on the decoded manifests. Both paths degrade
// safely: with no binding or an unreachable registry, registration is a
// no-op and the entity snapshot is empty, so authorization falls back to the
// static bootstrap policies (fail closed).

const REGISTRY_NAME = "service-registry";
const SNAPSHOT_TTL_MS = 30_000;

const registryStub = (env: Env) => {
  const namespace = env.SERVICE_REGISTRY;
  return namespace ? namespace.get(namespace.idFromName(REGISTRY_NAME)) : null;
};

const manifestBytes = (manifest: ServiceManifest): Uint8Array =>
  encodeServiceManifest({
    service: manifest.service,
    zone: manifest.zone,
    targets: manifest.targets,
    operations: manifest.operations,
    scopes: manifest.scopes ?? [],
  });

// At-most-once registration per isolate. A failed attempt clears the memo so
// the next event retries; the write itself is idempotent (keyed by service).
let registration: Promise<void> | null = null;

export const ensureRegistered = (env: Env, manifest: ServiceManifest): Promise<void> => {
  if (registration) {
    return registration;
  }
  const stub = registryStub(env);
  if (!stub) {
    registration = Promise.resolve();
    return registration;
  }
  registration = stub.register(manifestBytes(manifest)).catch((error) => {
    registration = null;
    logger.warn("service_registration_failed", {
      service: manifest.service,
      error: errorMessage(error),
    });
  });
  return registration;
};

let snapshot: { at: number; entities: EntityJson[] } | null = null;

// TTL-cached registry snapshot as Cedar entities: decode the capnp manifest
// list, keep only semantically valid manifests, derive entities. Unreachable
// registry serves the stale snapshot if one exists, else empty (static
// policies still apply).
export const registryEntities = async (env: Env): Promise<EntityJson[]> => {
  const stub = registryStub(env);
  if (!stub) {
    return [];
  }
  const now = Date.now();
  if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) {
    return snapshot.entities;
  }
  try {
    const manifests = decodeManifestSnapshot(await stub.snapshot()) ?? [];
    // isServiceManifest narrows the wire strings to the semantic vocabulary.
    const valid = manifests.filter((manifest): manifest is ServiceManifest & typeof manifest =>
      isServiceManifest(manifest),
    );
    const entities = manifestsToEntities(valid);
    snapshot = { at: now, entities };
    return entities;
  } catch (error) {
    logger.warn("service_registry_snapshot_failed", { error: errorMessage(error) });
    return snapshot?.entities ?? [];
  }
};

// Test seam: clears the per-isolate registration and snapshot memos.
export const resetRegistryCaches = () => {
  registration = null;
  snapshot = null;
};
