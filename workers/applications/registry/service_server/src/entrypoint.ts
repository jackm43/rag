import { WorkerEntrypoint } from "cloudflare:workers";

import { createServiceServer, ensureRegistered } from "../../../../../packages/auth";
import { decodeRegistryInvokeEnvelope } from "../../../../../packages/contracts";
import type { Env, RegistryInvokeResult, ServiceMessageBytes } from "../../../../../packages/contracts/types";
import { errorMessage, logger } from "../../../../../packages/logger";
import { REGISTRY_MANIFEST } from "./manifest";
import {
  createRegistryApplication,
  deleteRegistryApplication,
  getRegistryApplication,
  listRegistryApplications,
  updateRegistryApplication,
  verifyRegistryApplicationAttestations,
  type RegistryActor,
} from "./operations";

const server = (env: Env) => createServiceServer({
  self: "registry",
  expectedIssuers: ["registry"],
  env,
  operations: REGISTRY_MANIFEST.operations,
});

const denied = (): RegistryInvokeResult => ({
  status: 403,
  body: { error: "registry_request_denied" },
});

const parseRecord = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const parseActor = (value: string): RegistryActor | null => {
  const actor = parseRecord(value);
  if (
    !actor ||
    typeof actor.discordId !== "string" ||
    actor.discordId.length === 0 ||
    typeof actor.accessSub !== "string" ||
    actor.accessSub.length === 0 ||
    (actor.email !== undefined && typeof actor.email !== "string")
  ) {
    return null;
  }
  return {
    discordId: actor.discordId,
    accessSub: actor.accessSub,
    ...(actor.email ? { email: actor.email } : {}),
  };
};

const missingTarget = (): RegistryInvokeResult => ({
  status: 400,
  body: { error: "missing_target" },
});

export const handleRegistryInvoke = async (
  env: Env,
  message: ServiceMessageBytes,
): Promise<RegistryInvokeResult> => {
  await ensureRegistered(env, REGISTRY_MANIFEST);
  const request = await server(env).receive(message, decodeRegistryInvokeEnvelope, "binding");
  if (!request) {
    return denied();
  }

  const actor = parseActor(request.payload.actorJson);
  const body = parseRecord(request.payload.bodyJson);
  if (!actor || !body) {
    return { status: 400, body: { error: "invalid_request" } };
  }

  try {
    switch (request.payload.operation) {
      case "application.list":
        return { status: 200, body: await listRegistryApplications(env) };
      case "application.create":
        return { status: 202, body: await createRegistryApplication(env, actor, body) };
      case "application.get": {
        if (!request.payload.targetId) {
          return missingTarget();
        }
        const result = await getRegistryApplication(env, request.payload.targetId);
        return result.application ? { status: 200, body: result } : { status: 404, body: { error: "not_found" } };
      }
      case "application.update": {
        if (!request.payload.targetId) {
          return missingTarget();
        }
        const result = await updateRegistryApplication(env, actor, request.payload.targetId, body);
        return result.application ? { status: 202, body: result } : { status: 404, body: { error: "not_found" } };
      }
      case "application.delete": {
        if (!request.payload.targetId) {
          return missingTarget();
        }
        const result = await deleteRegistryApplication(env, actor, request.payload.targetId);
        return result.application
          ? { status: 202, body: result }
          : { status: 404, body: { error: "not_found" } };
      }
      case "application.attestations.verify": {
        if (!request.payload.targetId) {
          return missingTarget();
        }
        const result = await verifyRegistryApplicationAttestations(env, request.payload.targetId);
        return result
          ? { status: 200, body: result }
          : { status: 404, body: { error: "scaffold_not_found" } };
      }
    }
  } catch (error) {
    logger.warn("registry_invoke_failed", {
      operation: request.payload.operation,
      targetId: request.payload.targetId,
      error: errorMessage(error),
    });
    return { status: 400, body: { error: "invalid_request", detail: errorMessage(error) } };
  }
};

export class RegistryService extends WorkerEntrypoint<Env> {
  async invoke(message: ServiceMessageBytes): Promise<RegistryInvokeResult> {
    return handleRegistryInvoke(this.env, message);
  }
}
