import { isMachinePrincipal, isTrustZone, type MachinePrincipal, type TrustZone } from "./principal";

// A service's self-declared position: the zone it occupies, the services it
// exchanges into (targets), and the operations (envelope kinds) it accepts.
// Retained as a type only; the manifest registration + Cedar-entity derivation
// that used it were removed with the signing/registry machinery.
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
