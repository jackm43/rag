import type { Identity } from "../identity";
import {
  createPlatformServiceClient,
  type PlatformServiceConnection,
} from "../client/platform-service";
import { serviceConnection, type ServiceConnectionEnv, type ServiceConnectionTarget } from "../client/connector";

export const passThroughPlatformClient = async (
  application: string,
  env: ServiceConnectionEnv,
  target: ServiceConnectionTarget,
  identity: Identity,
) => {
  const connection = await serviceConnection(env, target);
  if (!connection) {
    throw new Error(`${application} service connection unavailable`);
  }
  return createPlatformServiceClient(application, connection, identity);
};

export type PassThroughTargetSpec = {
  application: string;
  endpointKey: string;
  bindingKey: string;
  scopes: string[];
};

export const passThroughConnection = async (
  env: ServiceConnectionEnv & Record<string, unknown>,
  spec: PassThroughTargetSpec,
): Promise<PlatformServiceConnection | null> => {
  const endpoint = env[spec.endpointKey];
  const binding = env[spec.bindingKey];
  if (typeof endpoint !== "string" || !endpoint) {
    return null;
  }
  return serviceConnection(env, {
    endpoint,
    binding: binding as ServiceConnectionTarget["binding"],
    scopes: spec.scopes,
  });
};

/** @deprecated Use passThroughPlatformClient */
export const bindingPlatformClient = passThroughPlatformClient;

/** @deprecated Use passThroughConnection */
export const bindingConnection = passThroughConnection;

/** @deprecated Use PassThroughTargetSpec */
export type BindingTargetSpec = PassThroughTargetSpec;
