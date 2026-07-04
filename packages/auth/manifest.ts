import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { isMachinePrincipal, isTrustZone, type MachinePrincipal, type TrustZone } from "./principal";

// A service's self-declared position: the zone it occupies, the services it
// exchanges into (targets), and the operations (envelope kinds) it accepts.
// Who may call the service is NOT self-declared — the registry derives each
// service's clients from the other manifests' targets, so a service cannot
// grant others access to itself by fiat.
export type ServiceManifest = {
  service: MachinePrincipal;
  zone: TrustZone;
  targets: MachinePrincipal[];
  operations: string[];
  // Runtime-registered control-plane/management resources owned by this
  // application.
  // Encoded over the existing service.capnp `scopes` field until resource
  // manifests get their own contract. Format: `gateway:<id>:<plane>`, where
  // plane is `control-plane`, `management`, or `data`.
  scopes?: string[];
};

export const isServiceManifest = (value: unknown): value is ServiceManifest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isMachinePrincipal(candidate.service) &&
    isTrustZone(candidate.zone) &&
    Array.isArray(candidate.targets) &&
    candidate.targets.every(isMachinePrincipal) &&
    Array.isArray(candidate.operations) &&
    candidate.operations.every((operation) => typeof operation === "string")
  );
};

const serviceMethodId = (service: MachinePrincipal, operation: string) => `${service}:${operation}`;

export const serviceResourceId = (service: MachinePrincipal, operation: string) =>
  serviceMethodId(service, operation);

const entityRef = (type: "Application" | "Service", id: string) => ({
  __entity: { type, id },
});

const gatewayResourceFromScope = (scope: string): EntityJson | null => {
  const [kind, id, plane] = scope.split(":");
  if (kind !== "gateway" || !id || !plane) {
    return null;
  }
  if (plane !== "control-plane" && plane !== "management" && plane !== "data") {
    return null;
  }
  return {
    uid: { type: "Gateway", id },
    attrs: { plane },
    parents: [],
  };
};

// The registry as Cedar entities: for each registered application, an
// Application principal/resource entity (zone, target applications), plus one
// method-level Service resource per operation it accepts. Service resources are
// data-plane method objects, so Cedar authorizes invocation against
// Service::<application>:<operation>, not a broad service bucket.
export const manifestsToEntities = (manifests: ServiceManifest[]): EntityJson[] => {
  const entities: EntityJson[] = [];
  for (const manifest of manifests) {
    const clients = manifests
      .filter((other) => other.targets.includes(manifest.service))
      .map((other) => entityRef("Application", other.service));
    entities.push(
      {
        uid: { type: "Application", id: manifest.service },
        attrs: {
          zone: manifest.zone,
          plane: "data",
          targets: manifest.targets.map((target) => entityRef("Application", target)),
          operations: manifest.operations,
        },
        parents: [],
      },
    );
    for (const operation of manifest.operations) {
      entities.push({
        uid: { type: "Service", id: serviceMethodId(manifest.service, operation) },
        attrs: {
          application: entityRef("Application", manifest.service),
          zone: manifest.zone,
          plane: "data",
          operation,
          clients,
        },
        parents: [],
      });
    }
    for (const scope of manifest.scopes ?? []) {
      const resource = gatewayResourceFromScope(scope);
      if (resource) {
        entities.push(resource);
      }
    }
  }
  return entities;
};
