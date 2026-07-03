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

const entityRef = (type: "Machine" | "Service", id: string) => ({
  __entity: { type, id },
});

// The registry as Cedar entities: for each registered service, a Machine
// principal entity (zone, targets, operations) and a Service resource entity
// (zone, clients derived from the OTHER manifests' targets). Pure so the
// position calculation is testable outside the Durable Object.
export const manifestsToEntities = (manifests: ServiceManifest[]): EntityJson[] => {
  const entities: EntityJson[] = [];
  for (const manifest of manifests) {
    const clients = manifests
      .filter((other) => other.targets.includes(manifest.service))
      .map((other) => entityRef("Machine", other.service));
    entities.push(
      {
        uid: { type: "Machine", id: manifest.service },
        attrs: {
          zone: manifest.zone,
          targets: manifest.targets.map((target) => entityRef("Service", target)),
          operations: manifest.operations,
        },
        parents: [],
      },
      {
        uid: { type: "Service", id: manifest.service },
        attrs: {
          zone: manifest.zone,
          clients,
        },
        parents: [],
      },
    );
  }
  return entities;
};
