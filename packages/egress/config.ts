import { isRecord } from "../contracts/validation";
import { isMachinePrincipal, type MachinePrincipal } from "../auth";
import type { EgressProfileConfig as WireEgressProfileConfig } from "../contracts/types";

export type EgressProfileConfig = WireEgressProfileConfig & {
  allowedCallers: MachinePrincipal[];
};

export type EgressConfig = {
  profiles?: Record<string, EgressProfileConfig>;
};

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);

export const isEgressProfileName = (value: unknown): value is string =>
  typeof value === "string" && PROFILE_PATTERN.test(value);

export const isEgressProfileConfig = (value: unknown): value is EgressProfileConfig => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.allowedCallers) ||
    !value.allowedCallers.every(isMachinePrincipal) ||
    !isStringArray(value.allowedHosts)
  ) {
    return false;
  }
  if (value.identity !== undefined && typeof value.identity !== "string") {
    return false;
  }
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs <= 0)
  ) {
    return false;
  }
  if (
    value.maxResponseBytes !== undefined &&
    (
      typeof value.maxResponseBytes !== "number" ||
      !Number.isInteger(value.maxResponseBytes) ||
      value.maxResponseBytes <= 0
    )
  ) {
    return false;
  }
  if (value.logPath !== undefined && typeof value.logPath !== "boolean") {
    return false;
  }
  if (value.credential === undefined) {
    return true;
  }
  return (
    isRecord(value.credential) &&
    typeof value.credential.header === "string" &&
    HEADER_NAME_PATTERN.test(value.credential.header) &&
    typeof value.credential.env === "string" &&
    ENV_NAME_PATTERN.test(value.credential.env) &&
    (value.credential.prefix === undefined || typeof value.credential.prefix === "string")
  );
};

export const isEgressConfig = (value: unknown): value is EgressConfig => {
  if (!isRecord(value) || value.profiles === undefined) {
    return isRecord(value);
  }
  return (
    isRecord(value.profiles) &&
    Object.entries(value.profiles).every(
      ([profile, config]) => PROFILE_PATTERN.test(profile) && isEgressProfileConfig(config),
    )
  );
};
