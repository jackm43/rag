import type { EgressEnv, EgressFetchInput, EgressResult } from "./contracts";
import { createBoundaryClient, type BoundaryCredential, type BoundaryPolicy } from "./outbound/boundary-client";
import { logger } from "@rag/logger";
import { isEgressProfileConfig, type EgressProfileConfig } from "./config";
import { DEFAULT_EGRESS_PROFILES } from "./profiles";
import type { EgressIdentityZone } from "./outbound/boundary-client";

type Env = EgressEnv;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

// Per-profile egress identity zone (a boundary-client logging label).
const zoneForProfile = (profile: string): EgressIdentityZone => {
  if (profile === "discord-rest" || profile === "discord-webhook") {
    return "egress-discord";
  }
  if (profile === "cloudflare-api") {
    return "egress-cloudflare-api";
  }
  if (profile === "media-download") {
    return "egress-media";
  }
  if (profile === "ai-gateway") {
    return "egress-ai-gateway";
  }
  return "egress-connector";
};

const credentialFor = (env: Env, config: EgressProfileConfig): BoundaryCredential | undefined => {
  if (!config.credential) {
    return undefined;
  }
  const value = env[config.credential.env as keyof Env];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Egress credential ${config.credential.env} is not configured`);
  }
  return {
    header: config.credential.header,
    value: `${config.credential.prefix ?? ""}${value}`,
  };
};

const policyFor = (env: Env, profile: string, url: string, config: EgressProfileConfig): BoundaryPolicy => ({
  identity: config.identity ?? profile,
  trustZone: zoneForProfile(profile),
  credential: credentialFor(env, config),
  allowedHosts:
    config.allowedHosts.length === 1 && config.allowedHosts[0] === "*"
      ? "*"
      : config.allowedHosts,
  defaultTimeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  logPath: config.logPath ?? !url.includes("/webhooks/"),
});

// Resolve the (caller, profile) config and authorize the caller. Authorization
// is now a plain data check — the profile's allowedCallers list — not Cedar.
const requireProfile = async (
  env: Env,
  caller: string,
  profile: string,
): Promise<{ profileId: string; config: EgressProfileConfig }> => {
  const profileId = `${caller}:${profile}`;
  const stored = env.EGRESS_CONTROL
    ? await env.EGRESS_CONTROL.get(env.EGRESS_CONTROL.idFromName(caller)).getProfile(profile)
    : null;
  const config = isEgressProfileConfig(stored)
    ? stored
    : DEFAULT_EGRESS_PROFILES[caller as keyof typeof DEFAULT_EGRESS_PROFILES]?.[profile];
  if (!isEgressProfileConfig(config)) {
    logger.warn("egress_profile_missing", { caller, profile });
    throw new Error(`Unknown egress profile: ${profileId}`);
  }
  if (!config.allowedCallers.includes(caller)) {
    logger.warn("egress_denied", { caller, profile, reason: "not_authorized" });
    throw new Error(`Egress profile denied: ${profileId}`);
  }
  return { profileId, config };
};

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

// The egress boundary: resolve + authorize the profile, then fetch through the
// boundary client (host allowlist + credential injection + caps). No signature
// verification — the EGRESS binding is trusted by capability.
export const handleEgressRequest = async (
  env: Env,
  input: EgressFetchInput,
  body?: ArrayBuffer,
): Promise<EgressResult> => {
  const { profileId, config } = await requireProfile(env, input.caller, input.profile);
  const client = createBoundaryClient(policyFor(env, input.profile, input.url, config));
  const response = await client(input.url, {
    method: input.method,
    headers: input.headers,
    ...(body && body.byteLength > 0 ? { body } : {}),
  });
  logger.info("egress_request_delivered", {
    profile: input.profile,
    profileId,
    caller: input.caller,
    status: response.status,
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    body: await response.arrayBuffer(),
  };
};
