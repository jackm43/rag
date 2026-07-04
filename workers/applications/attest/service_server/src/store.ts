import { DurableObject } from "cloudflare:workers";

import type { Env } from "../../../../../packages/contracts/types";
import type {
  AttestationVerification,
  GitHubAttestation,
  VerifyArtifactInput,
} from "../../../../../packages/attest/types";

const ATTESTATION_PREFIX = "attestation:";
const DELIVERY_PREFIX = "delivery:";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isArtifact = (value: unknown): value is GitHubAttestation["artifacts"][number] =>
  isRecord(value) &&
  isString(value.path) &&
  /^[a-f0-9]{64}$/.test(String(value.sha256)) &&
  isString(value.githubBlobSha);

const isAttestation = (value: unknown): value is GitHubAttestation =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.repository) &&
  isString(value.owner) &&
  isString(value.repo) &&
  isString(value.ref) &&
  /^[a-f0-9]{40}$/.test(String(value.commitSha)) &&
  (value.scope === "production" || value.scope === "pull_request" || value.scope === "branch") &&
  isString(value.receivedAt) &&
  !Number.isNaN(Date.parse(value.receivedAt)) &&
  Array.isArray(value.artifacts) &&
  value.artifacts.every(isArtifact) &&
  (value.pullRequestNumber === undefined || typeof value.pullRequestNumber === "number") &&
  (value.branchName === undefined || typeof value.branchName === "string") &&
  (value.actorLogin === undefined || typeof value.actorLogin === "string") &&
  (value.actorId === undefined || typeof value.actorId === "number") &&
  (value.eventId === undefined || typeof value.eventId === "string");

const isVerifyInput = (value: unknown): value is VerifyArtifactInput =>
  isRecord(value) &&
  isString(value.repository) &&
  isString(value.path) &&
  /^[a-f0-9]{64}$/.test(String(value.sha256)) &&
  (value.commitSha === undefined || /^[a-f0-9]{40}$/.test(String(value.commitSha))) &&
  (value.ref === undefined || typeof value.ref === "string") &&
  (value.productionOnly === undefined || typeof value.productionOnly === "boolean") &&
  (value.actorLogin === undefined || typeof value.actorLogin === "string");

const keyOf = (attestation: GitHubAttestation): string =>
  `${ATTESTATION_PREFIX}${attestation.repository}:${attestation.ref}:${attestation.commitSha}`;

const matches = (attestation: GitHubAttestation, input: VerifyArtifactInput): boolean => {
  if (attestation.repository !== input.repository) {
    return false;
  }
  if (input.commitSha !== undefined && attestation.commitSha !== input.commitSha) {
    return false;
  }
  if (input.ref !== undefined && attestation.ref !== input.ref) {
    return false;
  }
  if (input.productionOnly === true && attestation.scope !== "production") {
    return false;
  }
  if (input.actorLogin !== undefined && attestation.actorLogin !== input.actorLogin) {
    return false;
  }
  return attestation.artifacts.some((artifact) =>
    artifact.path === input.path && artifact.sha256 === input.sha256
  );
};

export class AttestationStore extends DurableObject<Env> {
  async record(attestation: unknown): Promise<void> {
    if (!isAttestation(attestation)) {
      throw new Error("Invalid attestation");
    }
    await this.ctx.storage.put(keyOf(attestation), attestation);
  }

  async list(repository?: string): Promise<GitHubAttestation[]> {
    const stored = await this.ctx.storage.list<unknown>({ prefix: ATTESTATION_PREFIX });
    return [...stored.values()]
      .filter(isAttestation)
      .filter((attestation) => repository === undefined || attestation.repository === repository);
  }

  async verifyArtifact(input: unknown): Promise<AttestationVerification> {
    if (!isVerifyInput(input)) {
      return { ok: false };
    }
    for (const attestation of await this.list(input.repository)) {
      if (matches(attestation, input)) {
        return { ok: true, attestation };
      }
    }
    return { ok: false };
  }

  async seenDelivery(deliveryId: string, ttlMs: number): Promise<boolean> {
    if (!deliveryId) {
      return false;
    }
    const key = `${DELIVERY_PREFIX}${deliveryId}`;
    if (await this.ctx.storage.get(key)) {
      return true;
    }
    await this.ctx.storage.put(key, { seenAt: Date.now(), ttlMs });
    return false;
  }
}
