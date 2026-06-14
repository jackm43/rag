import { logger, PlatformServiceError, type Identity } from "@platy/sdk";

import { cloudflareApiClient } from "./api";
import { deleteDevice, getDevice, listDevices, revokeDevice } from "./devices";
import { badRequest } from "./errors";
import { deployWorker, listWorkers, type DeployWorkerRequest } from "./workers";
import type { Env } from "./types";

export { PlatformServiceError as HttpServiceError };

const requireDeviceId = (deviceId: string): string => {
  const trimmed = deviceId.trim();
  if (!trimmed) {
    badRequest("device_id is required");
  }
  return trimmed;
};

export const listCloudflareDevices = async (
  env: Env,
  identity: Identity,
  params: {
    ids?: string[];
    activeRegistrations?: string;
    cursor?: string;
    include?: string;
    lastSeenUserEmail?: string;
    perPage?: number;
    search?: string;
    seenAfter?: string;
    seenBefore?: string;
    sortBy?: string;
    sortOrder?: string;
  },
) => listDevices(cloudflareApiClient(env, identity), env.CLOUDFLARE_ACCOUNT_ID, params);

export const getCloudflareDevice = async (
  env: Env,
  identity: Identity,
  deviceId: string,
  include?: string,
) => ({
  device: await getDevice(
    cloudflareApiClient(env, identity),
    env.CLOUDFLARE_ACCOUNT_ID,
    requireDeviceId(deviceId),
    include,
  ),
});

export const deleteCloudflareDevice = async (
  env: Env,
  identity: Identity,
  deviceId: string,
) => {
  const id = requireDeviceId(deviceId);
  logger.info("device_delete_requested", {
    device_id: id,
    actor: identity.email ?? identity.subject,
  });
  await deleteDevice(cloudflareApiClient(env, identity), env.CLOUDFLARE_ACCOUNT_ID, id);
  return {};
};

export const revokeCloudflareDevice = async (
  env: Env,
  identity: Identity,
  deviceId: string,
) => {
  const id = requireDeviceId(deviceId);
  logger.info("device_revoke_requested", {
    device_id: id,
    actor: identity.email ?? identity.subject,
  });
  await revokeDevice(cloudflareApiClient(env, identity), env.CLOUDFLARE_ACCOUNT_ID, id);
  return {};
};

export const deployCloudflareWorker = async (
  env: Env,
  identity: Identity,
  request: DeployWorkerRequest,
) => {
  logger.info("worker_deploy_requested", {
    script: request.scriptName,
    actor: identity.email ?? identity.subject,
  });
  return deployWorker(cloudflareApiClient(env, identity), env.CLOUDFLARE_ACCOUNT_ID, request);
};

export const listCloudflareWorkers = async (
  env: Env,
  identity: Identity,
) => listWorkers(cloudflareApiClient(env, identity), env.CLOUDFLARE_ACCOUNT_ID, {});
