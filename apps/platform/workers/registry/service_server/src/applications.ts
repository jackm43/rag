import { DurableObject } from "cloudflare:workers";

import { isTrustZone } from "@rag/service-kit/principal";
import type { Env } from "../../../../contracts";
import {
  REGISTRY_APPLICATION_ID_PATTERN,
  type RegistryApplicationMetadata,
  type RegistryApplicationRequest,
  type RegistryScaffold,
} from "../../../../lib/registry-kit/types";

const APP_PREFIX = "application:";
const SCAFFOLD_PREFIX = "scaffold:";
const ROUTE_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isShortText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

const isIdentifierList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 50 &&
  value.every((item) => typeof item === "string" && REGISTRY_APPLICATION_ID_PATTERN.test(item));

const isOperationList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((item) => typeof item === "string" && OPERATION_PATTERN.test(item));

const parseRoutes = (value: unknown): RegistryApplicationRequest["routes"] | null => {
  if (!Array.isArray(value) || value.length > 100) {
    return null;
  }
  const routes: RegistryApplicationRequest["routes"] = [];
  for (const route of value) {
    if (
      !isRecord(route) ||
      typeof route.method !== "string" ||
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(route.method) ||
      typeof route.path !== "string" ||
      !ROUTE_PATTERN.test(route.path) ||
      typeof route.operationId !== "string" ||
      !OPERATION_PATTERN.test(route.operationId) ||
      typeof route.serviceOperation !== "string" ||
      !OPERATION_PATTERN.test(route.serviceOperation)
    ) {
      return null;
    }
    routes.push({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      serviceOperation: route.serviceOperation,
    });
  }
  return routes;
};

const parseRequest = (input: unknown): RegistryApplicationRequest | null => {
  if (!isRecord(input)) {
    return null;
  }
  const routes = parseRoutes(input.routes ?? []);
  if (
    !isShortText(input.id, 64) ||
    !REGISTRY_APPLICATION_ID_PATTERN.test(input.id) ||
    !isShortText(input.displayName, 120) ||
    !isShortText(input.ownerDiscordId, 64) ||
    !isShortText(input.ownerAccessSub, 256) ||
    (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 1000)) ||
    !isTrustZone(input.zone) ||
    !isIdentifierList(input.targets) ||
    !isOperationList(input.operations) ||
    routes === null
  ) {
    return null;
  }
  return {
    id: input.id,
    displayName: input.displayName,
    ownerDiscordId: input.ownerDiscordId,
    ownerAccessSub: input.ownerAccessSub,
    ...(input.description ? { description: input.description } : {}),
    zone: input.zone,
    targets: input.targets,
    operations: input.operations,
    routes,
  };
};

const asMetadata = (value: unknown): RegistryApplicationMetadata | null => {
  if (!isRecord(value)) {
    return null;
  }
  const routes = parseRoutes(value.routes);
  return (
    isShortText(value.id, 64) &&
    REGISTRY_APPLICATION_ID_PATTERN.test(value.id) &&
    isShortText(value.displayName, 120) &&
    isShortText(value.ownerDiscordId, 64) &&
    isShortText(value.ownerAccessSub, 256) &&
    typeof value.requestedAt === "string" &&
    !Number.isNaN(Date.parse(value.requestedAt)) &&
    isTrustZone(value.zone) &&
    isIdentifierList(value.targets) &&
    isOperationList(value.operations) &&
    routes !== null &&
    (value.status === "requested" ||
      value.status === "scaffolded" ||
      value.status === "submitted" ||
      value.status === "approved" ||
      value.status === "rejected" ||
      value.status === "deleted")
  )
    ? {
      id: value.id,
      displayName: value.displayName,
      ownerDiscordId: value.ownerDiscordId,
      ownerAccessSub: value.ownerAccessSub,
      ...(typeof value.description === "string" && value.description.length > 0
        ? { description: value.description }
        : {}),
      zone: value.zone,
      requestedAt: value.requestedAt,
      status: value.status,
      targets: value.targets,
      operations: value.operations,
      routes,
    }
    : null;
};

export class ApplicationRegistry extends DurableObject<Env> {
  async create(input: unknown): Promise<RegistryApplicationMetadata> {
    const request = parseRequest(input);
    if (!request) {
      throw new Error("Invalid application request");
    }
    const key = `${APP_PREFIX}${request.id}`;
    if (await this.ctx.storage.get(key)) {
      throw new Error("Application already exists");
    }
    const metadata: RegistryApplicationMetadata = {
      ...request,
      requestedAt: new Date().toISOString(),
      status: "requested",
    };
    await this.ctx.storage.put(key, metadata);
    return metadata;
  }

  async get(id: string): Promise<RegistryApplicationMetadata | null> {
    if (!REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
      return null;
    }
    return asMetadata(await this.ctx.storage.get(`${APP_PREFIX}${id}`));
  }

  async list(): Promise<RegistryApplicationMetadata[]> {
    const stored = await this.ctx.storage.list<unknown>({ prefix: APP_PREFIX });
    return [...stored.values()].map(asMetadata).filter((item): item is RegistryApplicationMetadata => item !== null);
  }

  async update(id: string, input: unknown): Promise<RegistryApplicationMetadata | null> {
    const existing = await this.get(id);
    const request = parseRequest({ ...(isRecord(input) ? input : {}), id });
    if (!existing || !request) {
      return null;
    }
    const updated: RegistryApplicationMetadata = {
      ...existing,
      ...request,
      status: "requested",
    };
    await this.ctx.storage.put(`${APP_PREFIX}${id}`, updated);
    return updated;
  }

  async remove(id: string, actor: unknown): Promise<RegistryApplicationMetadata | null> {
    const existing = await this.get(id);
    if (!existing || !isRecord(actor) || actor.discordId !== existing.ownerDiscordId) {
      return null;
    }
    const deleted: RegistryApplicationMetadata = { ...existing, status: "deleted" };
    await this.ctx.storage.put(`${APP_PREFIX}${id}`, deleted);
    return deleted;
  }

  async putScaffoldResult(applicationId: string, result: unknown): Promise<void> {
    const existing = await this.get(applicationId);
    if (!existing || !isRecord(result)) {
      return;
    }
    await this.ctx.storage.put(`${SCAFFOLD_PREFIX}${applicationId}`, result);
    await this.ctx.storage.put(`${APP_PREFIX}${applicationId}`, {
      ...existing,
      status: "scaffolded",
    } satisfies RegistryApplicationMetadata);
  }

  async getScaffoldResult(applicationId: string): Promise<RegistryScaffold | null> {
    if (!REGISTRY_APPLICATION_ID_PATTERN.test(applicationId)) {
      return null;
    }
    return (await this.ctx.storage.get(`${SCAFFOLD_PREFIX}${applicationId}`)) ?? null;
  }
}
