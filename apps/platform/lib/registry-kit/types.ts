import type { TrustZone } from "@rag/service-kit/principal";

export const REGISTRY_APPLICATION_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
export const REGISTRY_EVENT_KINDS = [
  "application.create_requested",
  "application.update_requested",
  "application.delete_requested",
] as const;

export type RegistryEventKind = typeof REGISTRY_EVENT_KINDS[number];

export type RegistryRoute = {
  method: string;
  path: string;
  operationId: string;
  serviceOperation: string;
};

export type RegistryApplicationMetadata = {
  id: string;
  displayName: string;
  ownerDiscordId: string;
  ownerAccessSub: string;
  description?: string;
  zone: TrustZone;
  requestedAt: string;
  status: "requested" | "scaffolded" | "submitted" | "approved" | "rejected" | "deleted";
  targets: string[];
  operations: string[];
  routes: RegistryRoute[];
};

export type RegistryApplicationRequest = {
  id: string;
  displayName: string;
  ownerDiscordId: string;
  ownerAccessSub: string;
  description?: string;
  zone: TrustZone;
  targets: string[];
  operations: string[];
  routes: RegistryRoute[];
};

export type RegistryEvent = {
  id: string;
  kind: RegistryEventKind;
  applicationId: string;
  actorDiscordId: string;
  actorAccessSub: string;
  occurredAt: string;
  metadata: RegistryApplicationMetadata;
};

export type RegistryArtifact = {
  path: string;
  content: string;
  sha256: string;
};

export type RegistryScaffold = {
  applicationId: string;
  metadataSha256: string;
  artifacts: RegistryArtifact[];
};
