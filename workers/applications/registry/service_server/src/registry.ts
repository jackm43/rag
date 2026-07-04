import { DurableObject } from "cloudflare:workers";

import {
  decodeServiceManifest,
  encodeManifestSnapshot,
  type WireServiceManifest,
} from "../../../../../packages/contracts";
import { isServiceManifest } from "../../../../../packages/auth/manifest";
import {
  SERVICE_OPERATIONS,
  SERVICE_SCOPES,
  SERVICE_TARGETS,
  SERVICE_ZONE,
  isMachinePrincipal,
  type MachinePrincipal,
} from "../../../../../packages/auth/principal";
import { logger } from "../../../../../packages/logger";
import type { Env } from "../../../../../packages/contracts/types";

// Service registry: workers register their manifest (zone, targets,
// operations) over the SERVICE_REGISTRY binding, and the Cedar authorizer
// consumes the registry snapshot. Both RPC payloads are capnp bytes
// (service.capnp): ServiceManifest in, ManifestSnapshot out — the same
// generated contract layer as the queue envelopes. The registry lives in the
// trusted zone in its own worker so no routed, internet-facing worker owns it;
// only workers configured with the binding can reach it.
//
// Position calculation happens on the consumer (packages/auth/manifest.ts,
// manifestsToEntities): a service's CLIENTS are derived from the OTHER
// manifests' declared targets — a service cannot grant callers access to
// itself, and a caller only gains access when policy (services.cedar) accepts
// the resulting entity attributes.

const MANIFEST_PREFIX = "manifest:";
const INTENT_PREFIX = "intent:";
const PLACEMENT_PREFIX = "placement:";

type StoredIntent = {
  id: string;
  iss: MachinePrincipal;
  sub: string;
  aud: MachinePrincipal;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  correlationId: string;
  subject: string;
  initiatingApplication: MachinePrincipal;
  action: string;
  resource: string;
  method: string;
  allowedApplications: MachinePrincipal[];
  expiresAt: number;
  version: number;
  revokedAt?: number;
};

type StoredPlacement = {
  id: string;
  iss: MachinePrincipal;
  sub: string;
  aud: MachinePrincipal;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  correlationId: string;
  requestId: string;
  subject: string;
  source: MachinePrincipal;
  target: MachinePrincipal;
  action: string;
  resource: string;
  method: string;
  expiresAt: number;
  intentVersion: number;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

const isIntent = (value: unknown): value is StoredIntent => {
  const record = asRecord(value);
  return !!record &&
    typeof record.id === "string" &&
    isMachinePrincipal(record.iss) &&
    typeof record.sub === "string" &&
    isMachinePrincipal(record.aud) &&
    typeof record.iat === "number" &&
    typeof record.nbf === "number" &&
    typeof record.exp === "number" &&
    typeof record.jti === "string" &&
    typeof record.correlationId === "string" &&
    typeof record.subject === "string" &&
    isMachinePrincipal(record.initiatingApplication) &&
    typeof record.action === "string" &&
    typeof record.resource === "string" &&
    typeof record.method === "string" &&
    Array.isArray(record.allowedApplications) &&
    record.allowedApplications.every(isMachinePrincipal) &&
    typeof record.expiresAt === "number" &&
    typeof record.version === "number" &&
    (record.revokedAt === undefined || typeof record.revokedAt === "number");
};

const isPlacement = (value: unknown): value is StoredPlacement => {
  const record = asRecord(value);
  return !!record &&
    typeof record.id === "string" &&
    isMachinePrincipal(record.iss) &&
    typeof record.sub === "string" &&
    isMachinePrincipal(record.aud) &&
    typeof record.iat === "number" &&
    typeof record.nbf === "number" &&
    typeof record.exp === "number" &&
    typeof record.jti === "string" &&
    typeof record.correlationId === "string" &&
    typeof record.requestId === "string" &&
    typeof record.subject === "string" &&
    isMachinePrincipal(record.source) &&
    isMachinePrincipal(record.target) &&
    typeof record.action === "string" &&
    typeof record.resource === "string" &&
    typeof record.method === "string" &&
    typeof record.expiresAt === "number" &&
    typeof record.intentVersion === "number";
};

const ttlMs = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const sameStrings = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sourceControlledManifest = (decoded: WireServiceManifest): WireServiceManifest | null => {
  if (!isMachinePrincipal(decoded.service)) {
    return null;
  }
  const service = decoded.service;
  const targets = SERVICE_TARGETS[service];
  const operations = SERVICE_OPERATIONS[service];
  const scopes = SERVICE_SCOPES[service];
  if (
    decoded.zone !== SERVICE_ZONE[service] ||
    !sameStrings(decoded.targets, targets) ||
    !sameStrings(decoded.operations, operations) ||
    !sameStrings(decoded.scopes ?? [], scopes)
  ) {
    return null;
  }
  return {
    service,
    zone: SERVICE_ZONE[service],
    targets: [...targets],
    operations: [...operations],
    scopes: [...scopes],
  };
};

export class ServiceRegistry extends DurableObject<Env> {
  async register(manifest: unknown): Promise<void> {
    const decoded = decodeServiceManifest(manifest);
    if (!decoded || !isServiceManifest(decoded)) {
      throw new Error("Invalid service manifest");
    }
    const trusted = sourceControlledManifest(decoded);
    if (!trusted) {
      throw new Error("Service manifest does not match source-controlled topology");
    }
    await this.ctx.storage.put(`${MANIFEST_PREFIX}${trusted.service}`, trusted);
    logger.info("service_registered", {
      service: trusted.service,
      zone: trusted.zone,
      targets: trusted.targets,
    });
  }

  async snapshot(): Promise<Uint8Array> {
    const stored = await this.ctx.storage.list<WireServiceManifest>({ prefix: MANIFEST_PREFIX });
    return encodeManifestSnapshot([...stored.values()]);
  }

  async createIntent(input: unknown): Promise<StoredIntent> {
    const record = asRecord(input);
    if (
      !record ||
      !isMachinePrincipal(record.iss) ||
      typeof record.sub !== "string" ||
      !isMachinePrincipal(record.aud) ||
      typeof record.jti !== "string" ||
      typeof record.correlationId !== "string" ||
      typeof record.subject !== "string" ||
      !isMachinePrincipal(record.initiatingApplication) ||
      typeof record.action !== "string" ||
      typeof record.resource !== "string" ||
      typeof record.method !== "string" ||
      !Array.isArray(record.allowedApplications) ||
      !record.allowedApplications.every(isMachinePrincipal)
    ) {
      throw new Error("Invalid request intent");
    }

    const now = Date.now();
    const expiresAt = now + ttlMs(record.ttlMs, 5 * 60_000);
    const intent: StoredIntent = {
      id: crypto.randomUUID(),
      iss: record.iss,
      sub: record.sub,
      aud: record.aud,
      iat: Math.floor(now / 1000),
      nbf: Math.floor(now / 1000),
      exp: Math.floor(expiresAt / 1000),
      jti: record.jti,
      correlationId: record.correlationId,
      subject: record.subject,
      initiatingApplication: record.initiatingApplication,
      action: record.action,
      resource: record.resource,
      method: record.method,
      allowedApplications: record.allowedApplications,
      expiresAt,
      version: 1,
    };
    await this.ctx.storage.put(`${INTENT_PREFIX}${intent.id}`, intent);
    logger.info("request_intent_created", {
      requestId: intent.id,
      correlationId: intent.correlationId,
      subject: intent.subject,
      initiatingApplication: intent.initiatingApplication,
      action: intent.action,
      resource: intent.resource,
      method: intent.method,
    });
    return intent;
  }

  async createPlacement(input: unknown): Promise<StoredPlacement | null> {
    const record = asRecord(input);
    if (
      !record ||
      !isMachinePrincipal(record.iss) ||
      typeof record.sub !== "string" ||
      !isMachinePrincipal(record.aud) ||
      typeof record.jti !== "string" ||
      typeof record.correlationId !== "string" ||
      typeof record.requestId !== "string" ||
      typeof record.subject !== "string" ||
      !isMachinePrincipal(record.source) ||
      !isMachinePrincipal(record.target) ||
      typeof record.action !== "string" ||
      typeof record.resource !== "string" ||
      typeof record.method !== "string"
    ) {
      throw new Error("Invalid request placement");
    }

    const intent = await this.ctx.storage.get<StoredIntent>(`${INTENT_PREFIX}${record.requestId}`);
    const now = Date.now();
    if (
      !isIntent(intent) ||
      intent.revokedAt !== undefined ||
      intent.expiresAt <= now ||
      now < intent.nbf * 1000 ||
      intent.subject !== record.subject ||
      intent.sub !== record.sub ||
      intent.correlationId !== record.correlationId ||
      !intent.allowedApplications.includes(record.target)
    ) {
      return null;
    }

    const expiresAt = now + ttlMs(record.ttlMs, 90_000);
    const placement: StoredPlacement = {
      id: crypto.randomUUID(),
      iss: record.iss,
      sub: record.sub,
      aud: record.aud,
      iat: Math.floor(now / 1000),
      nbf: Math.floor(now / 1000),
      exp: Math.floor(expiresAt / 1000),
      jti: record.jti,
      correlationId: record.correlationId,
      requestId: record.requestId,
      subject: record.subject,
      source: record.source,
      target: record.target,
      action: record.action,
      resource: record.resource,
      method: record.method,
      expiresAt,
      intentVersion: intent.version,
    };
    await this.ctx.storage.put(`${PLACEMENT_PREFIX}${placement.id}`, placement);
    logger.info("request_placement_created", {
      placementId: placement.id,
      requestId: placement.requestId,
      correlationId: placement.correlationId,
      source: placement.source,
      target: placement.target,
      action: placement.action,
      resource: placement.resource,
      method: placement.method,
    });
    return placement;
  }

  async revokeIntent(requestId: unknown): Promise<StoredIntent | null> {
    if (typeof requestId !== "string") {
      throw new Error("Invalid request id");
    }
    const key = `${INTENT_PREFIX}${requestId}`;
    const intent = await this.ctx.storage.get<StoredIntent>(key);
    if (!isIntent(intent)) {
      return null;
    }
    const revoked: StoredIntent = {
      ...intent,
      version: intent.version + 1,
      revokedAt: Date.now(),
    };
    await this.ctx.storage.put(key, revoked);
    logger.info("request_intent_revoked", {
      requestId: revoked.id,
      subject: revoked.subject,
      version: revoked.version,
    });
    return revoked;
  }

  async bumpIntentVersion(requestId: unknown): Promise<StoredIntent | null> {
    if (typeof requestId !== "string") {
      throw new Error("Invalid request id");
    }
    const key = `${INTENT_PREFIX}${requestId}`;
    const intent = await this.ctx.storage.get<StoredIntent>(key);
    if (!isIntent(intent)) {
      return null;
    }
    const updated: StoredIntent = {
      ...intent,
      version: intent.version + 1,
    };
    await this.ctx.storage.put(key, updated);
    logger.info("request_intent_version_bumped", {
      requestId: updated.id,
      subject: updated.subject,
      version: updated.version,
    });
    return updated;
  }

  async consumePlacement(input: unknown): Promise<boolean> {
    const record = asRecord(input);
    if (
      !record ||
      typeof record.placementId !== "string" ||
      typeof record.requestId !== "string" ||
      (record.correlationId !== undefined && typeof record.correlationId !== "string") ||
      typeof record.subject !== "string" ||
      !isMachinePrincipal(record.source) ||
      !isMachinePrincipal(record.target) ||
      typeof record.action !== "string" ||
      typeof record.resource !== "string" ||
      typeof record.method !== "string"
    ) {
      return false;
    }

    const key = `${PLACEMENT_PREFIX}${record.placementId}`;
    const placement = await this.ctx.storage.get<StoredPlacement>(key);
    if (!isPlacement(placement)) {
      return false;
    }

    // Delete before returning so concurrent/replayed receives cannot reuse the
    // same placement. Durable Object method execution is single-threaded for
    // this object, making this consume atomic for its shard.
    await this.ctx.storage.delete(key);

    const intent = await this.ctx.storage.get<StoredIntent>(`${INTENT_PREFIX}${record.requestId}`);
    const now = Date.now();
    return isIntent(intent) &&
      intent.revokedAt === undefined &&
      intent.expiresAt > now &&
      intent.version === placement.intentVersion &&
      now >= placement.nbf * 1000 &&
      placement.expiresAt > now &&
      placement.requestId === record.requestId &&
      (record.correlationId === undefined || placement.correlationId === record.correlationId) &&
      placement.subject === record.subject &&
      placement.source === record.source &&
      placement.target === record.target &&
      placement.action === record.action &&
      placement.resource === record.resource &&
      placement.method === record.method &&
      intent.subject === record.subject &&
      intent.sub === record.subject &&
      intent.correlationId === placement.correlationId &&
      intent.allowedApplications.includes(record.target);
  }
}
