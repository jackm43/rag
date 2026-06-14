import type { PlatformClient } from "@platy/sdk";

import { appendQuery, apiRequest } from "./api";

type ApiDevicePolicy = {
  id?: string;
  default?: boolean;
  deleted?: boolean;
  name?: string;
  updated_at?: string;
};

type ApiDeviceRegistration = {
  policy?: ApiDevicePolicy;
};

type ApiDeviceUser = {
  id?: string;
  email?: string;
  name?: string;
};

type ApiDevice = {
  id?: string;
  active_registrations?: number;
  created_at?: string;
  last_seen_at?: string;
  name?: string;
  updated_at?: string;
  client_version?: string;
  deleted_at?: string;
  device_type?: string;
  hardware_id?: string;
  last_seen_registration?: ApiDeviceRegistration;
  last_seen_user?: ApiDeviceUser;
  mac_address?: string;
  manufacturer?: string;
  model?: string;
  os_version?: string;
  os_version_extra?: string;
  serial_number?: string;
};

export type DevicePolicySummary = {
  id: string;
  default: boolean;
  deleted: boolean;
  name: string;
  updatedAt: string;
};

export type DeviceRegistrationSummary = {
  policy: DevicePolicySummary;
};

export type DeviceUserSummary = {
  id: string;
  email: string;
  name: string;
};

export type Device = {
  id: string;
  activeRegistrations: number;
  createdAt: string;
  lastSeenAt: string;
  name: string;
  updatedAt: string;
  clientVersion: string;
  deletedAt: string;
  deviceType: string;
  hardwareId: string;
  lastSeenRegistration?: DeviceRegistrationSummary;
  lastSeenUser?: DeviceUserSummary;
  macAddress: string;
  manufacturer: string;
  model: string;
  osVersion: string;
  osVersionExtra: string;
  serialNumber: string;
};

const policySummary = (policy?: ApiDevicePolicy) => {
  if (!policy) {
    return undefined;
  }
  return {
    id: policy.id ?? "",
    default: policy.default ?? false,
    deleted: policy.deleted ?? false,
    name: policy.name ?? "",
    updatedAt: policy.updated_at ?? "",
  };
};

const registrationSummary = (registration?: ApiDeviceRegistration) => {
  if (!registration) {
    return undefined;
  }
  const policy = policySummary(registration.policy);
  return policy ? { policy } : undefined;
};

const userSummary = (user?: ApiDeviceUser) => {
  if (!user) {
    return undefined;
  }
  return {
    id: user.id ?? "",
    email: user.email ?? "",
    name: user.name ?? "",
  };
};

export const mapDevice = (device: ApiDevice): Device =>
  ({
    id: device.id ?? "",
    activeRegistrations: device.active_registrations ?? 0,
    createdAt: device.created_at ?? "",
    lastSeenAt: device.last_seen_at ?? "",
    name: device.name ?? "",
    updatedAt: device.updated_at ?? "",
    clientVersion: device.client_version ?? "",
    deletedAt: device.deleted_at ?? "",
    deviceType: device.device_type ?? "",
    hardwareId: device.hardware_id ?? "",
    lastSeenRegistration: registrationSummary(device.last_seen_registration),
    lastSeenUser: userSummary(device.last_seen_user),
    macAddress: device.mac_address ?? "",
    manufacturer: device.manufacturer ?? "",
    model: device.model ?? "",
    osVersion: device.os_version ?? "",
    osVersionExtra: device.os_version_extra ?? "",
    serialNumber: device.serial_number ?? "",
  });

export const devicesBasePath = (accountId: string): string => `/accounts/${accountId}/devices/physical-devices`;

export const listDevices = async (
  client: PlatformClient,
  accountId: string,
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
) => {
  const path = appendQuery(devicesBasePath(accountId), {
    id: params.ids?.join(","),
    active_registrations: params.activeRegistrations,
    cursor: params.cursor,
    include: params.include,
    "last_seen_user.email": params.lastSeenUserEmail,
    per_page: params.perPage,
    search: params.search,
    seen_after: params.seenAfter,
    seen_before: params.seenBefore,
    sort_by: params.sortBy,
    sort_order: params.sortOrder,
  });
  const { result, resultInfo } = await apiRequest<ApiDevice[]>(client, path);
  return {
    devices: result.map(mapDevice),
    nextCursor: resultInfo?.cursor ?? "",
    count: resultInfo?.count ?? result.length,
    perPage: resultInfo?.per_page ?? params.perPage ?? result.length,
  };
};

export const getDevice = async (
  client: PlatformClient,
  accountId: string,
  deviceId: string,
  include?: string,
): Promise<Device> => {
  const path = appendQuery(`${devicesBasePath(accountId)}/${deviceId}`, { include });
  const { result } = await apiRequest<ApiDevice>(client, path);
  return mapDevice(result);
};

export const deleteDevice = async (client: PlatformClient, accountId: string, deviceId: string): Promise<void> => {
  await apiRequest<Record<string, never>>(client, `${devicesBasePath(accountId)}/${deviceId}`, {
    method: "DELETE",
  });
};

export const revokeDevice = async (client: PlatformClient, accountId: string, deviceId: string): Promise<void> => {
  await apiRequest<Record<string, never>>(client, `${devicesBasePath(accountId)}/${deviceId}/revoke`, {
    method: "POST",
  });
};
