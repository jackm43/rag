import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";

import { DeviceService } from "../../server/cloudflare/v1/device_service_pb";
import { WorkerService } from "../../server/cloudflare/v1/worker_service_pb";
import { logger, platformAuthenticator, protect, requireIdentity, type AuthPolicy } from "../../../../sdk/ts/src";
import { cloudflareApiClient } from "./api";
import { deleteDevice, getDevice, listDevices, revokeDevice } from "./devices";
import { deployWorker, listWorkers } from "./workers";
import type { Env } from "./types";

const requireDeviceId = (deviceId: string): string => {
  const trimmed = deviceId.trim();
  if (!trimmed) {
    throw new ConnectError("device_id is required", Code.InvalidArgument);
  }
  return trimmed;
};

export const registerCloudflareServices = (router: ConnectRouter, env: Env) => {
  const policy: AuthPolicy = { authenticate: platformAuthenticator(env, "cloudflare") };

  router.service(
    DeviceService,
    protect(
      DeviceService,
      {
        listDevices: async (request, context) => {
          const identity = requireIdentity(context);
          const client = cloudflareApiClient(env, identity);
          return listDevices(client, env.CLOUDFLARE_ACCOUNT_ID, {
            ids: request.ids,
            activeRegistrations: request.activeRegistrations,
            cursor: request.cursor,
            include: request.include,
            lastSeenUserEmail: request.lastSeenUserEmail,
            perPage: request.perPage || undefined,
            search: request.search,
            seenAfter: request.seenAfter,
            seenBefore: request.seenBefore,
            sortBy: request.sortBy,
            sortOrder: request.sortOrder,
          });
        },
        getDevice: async (request, context) => {
          const identity = requireIdentity(context);
          const client = cloudflareApiClient(env, identity);
          const deviceId = requireDeviceId(request.deviceId);
          return {
            device: await getDevice(client, env.CLOUDFLARE_ACCOUNT_ID, deviceId, request.include),
          };
        },
        deleteDevice: async (request, context) => {
          const identity = requireIdentity(context);
          const client = cloudflareApiClient(env, identity);
          const deviceId = requireDeviceId(request.deviceId);
          logger.info("device_delete_requested", {
            device_id: deviceId,
            actor: identity.email ?? identity.subject,
          });
          await deleteDevice(client, env.CLOUDFLARE_ACCOUNT_ID, deviceId);
          return {};
        },
        revokeDevice: async (request, context) => {
          const identity = requireIdentity(context);
          const client = cloudflareApiClient(env, identity);
          const deviceId = requireDeviceId(request.deviceId);
          logger.info("device_revoke_requested", {
            device_id: deviceId,
            actor: identity.email ?? identity.subject,
          });
          await revokeDevice(client, env.CLOUDFLARE_ACCOUNT_ID, deviceId);
          return {};
        },
      },
      policy,
    ),
  );

  router.service(
    WorkerService,
    protect(
      WorkerService,
      {
        deployWorker: async (request, context) => {
          const identity = requireIdentity(context);
          const client = cloudflareApiClient(env, identity);
          logger.info("worker_deploy_requested", {
            script: request.scriptName,
            actor: identity.email ?? identity.subject,
          });
          return deployWorker(client, env.CLOUDFLARE_ACCOUNT_ID, request);
        },
        listWorkers: async (request, context) => {
          const identity = requireIdentity(context);
          const client = cloudflareApiClient(env, identity);
          return listWorkers(client, env.CLOUDFLARE_ACCOUNT_ID, request);
        },
      },
      policy,
    ),
  );
};
