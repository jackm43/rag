import { createServiceServer } from "@rag/service-kit";
import type { MachinePrincipal } from "@rag/service-kit";
import { authorize } from "@rag/authz/authorize";
import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { decodeEgressRequestEnvelope, MAX_EGRESS_BODY_BYTES } from "@rag/egress/contracts";
import type { EgressRequestJob, EgressResult } from "@rag/egress/contracts";
import type { EgressEnv } from "./contracts";
import type { ServiceKitEnv } from "@rag/service-kit/env";

type Env = EgressEnv & ServiceKitEnv;
import { createBoundaryClient, type BoundaryCredential, type BoundaryPolicy } from "./outbound/boundary-client";
import { envelopeSha256 } from "@rag/service-kit/identity";
import { logger } from "@rag/logger";
import { isEgressProfileConfig, type EgressProfileConfig } from "./config";
import { DEFAULT_EGRESS_PROFILES } from "./profiles";
import type { EgressIdentityZone } from "./outbound/boundary-client";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

// Per-profile egress identity zone (a boundary-client logging label). Derived
// from the profile name now that discord, cloudflare-api, media-download and
// ai-gateway all flow through this one server; unknown/connector-provider
// profiles fall back to egress-connector.
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

const policyFor = (env: Env, profile: string, job: EgressRequestJob, config: EgressProfileConfig): BoundaryPolicy => {
  return {
    identity: config.identity ?? profile,
    trustZone: zoneForProfile(profile),
    credential: credentialFor(env, config),
    // A config allowedHosts of exactly ["*"] is the wildcard sentinel:
    // EgressProfileConfig.allowedHosts is always string[] (config validation
    // has no wildcard case), so map it to boundary-client's "*" literal here.
    allowedHosts:
      config.allowedHosts.length === 1 && config.allowedHosts[0] === "*"
        ? "*"
        : config.allowedHosts,
    defaultTimeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    logPath: config.logPath ?? !job.url.includes("/webhooks/"),
  };
};

const profileEntity = (
  profileId: string,
  config: EgressProfileConfig,
): EntityJson => ({
  uid: { type: "EgressSidecar", id: profileId },
  attrs: {
    plane: "data",
    callers: config.allowedCallers.map((caller) => ({ __entity: { type: "Application", id: caller } })),
  },
  parents: [],
});

const requireProfile = async (
  env: Env,
  caller: MachinePrincipal,
  profile: string,
): Promise<{ profileId: string; config: EgressProfileConfig }> => {
  const profileId = `${caller}:${profile}`;
  // The DO-stored profile wins whenever it exists. Nothing seeds the DO on a
  // fresh deploy (and the binding may not even be present yet), so when the
  // requested profile is absent from the DO — or the DO binding is absent
  // entirely — fall back to the committed bundled default for this
  // (caller, profile) pair.
  const stored = env.EGRESS_CONTROL
    ? await env.EGRESS_CONTROL.get(env.EGRESS_CONTROL.idFromName(caller)).getProfile(profile)
    : null;
  const config = isEgressProfileConfig(stored)
    ? stored
    : DEFAULT_EGRESS_PROFILES[caller]?.[profile];
  if (!isEgressProfileConfig(config)) {
    logger.warn("egress_profile_missing", { caller, profile });
    throw new Error(`Unknown egress profile: ${profileId}`);
  }
  const decision = authorize(
    {
      principal: { type: "Application", id: caller },
      action: "egress.use",
      resource: { type: "EgressSidecar", id: profileId },
    },
    [profileEntity(profileId, config)],
  );
  if (!decision.allowed) {
    logger.warn("egress_denied", { caller, profile, reason: "not_authorized" });
    throw new Error(`Egress profile denied: ${profileId}`);
  }
  return { profileId, config };
};

const headersFromJson = (headersJson: string): Record<string, string> =>
  JSON.parse(headersJson) as Record<string, string>;

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

const verifyBodyHash = async (job: EgressRequestJob, body: ArrayBuffer | undefined) => {
  if (!body || body.byteLength === 0) {
    if (job.bodySha256 !== undefined) {
      throw new Error("Egress body hash present without body bytes");
    }
    return;
  }
  if (body.byteLength > MAX_EGRESS_BODY_BYTES) {
    throw new Error("Egress request body exceeds size limit");
  }
  const actual = await envelopeSha256(new Uint8Array(body));
  if (actual !== job.bodySha256) {
    throw new Error("Egress request body hash mismatch");
  }
};

const egressServer = (env: Env) =>
  createServiceServer({
    self: "egress",
    expectedIssuers: ["responder", "connectors", "workflows", "spend"],
    env,
    // Egress is only reachable over the EGRESS service binding, which the
    // platform gates by capability — a worker can call it only if its wrangler
    // config declares the binding. So the caller is authenticated by the binding
    // graph itself; the signed identity token adds no trust here. Read the
    // caller + on-behalf-of subject from the claims without verifying a
    // signature. External inbound is verified at the edges (webhook/interaction
    // hooks), not here.
    transportTrust: { binding: "trusted" },
    authorizeInvoke: false,
  });

export const handleEgressRequest = async (
  env: Env,
  message: unknown,
  body?: ArrayBuffer,
): Promise<EgressResult> => {
  const received = await egressServer(env).receive(message, decodeEgressRequestEnvelope, "binding");
  if (!received) {
    throw new Error("Invalid egress request envelope");
  }
  const job = received.payload;
  await verifyBodyHash(job, body);
  const { profileId, config } = await requireProfile(env, received.context.source, job.profile);

  const client = createBoundaryClient(policyFor(env, job.profile, job, config));
  const response = await client(job.url, {
    method: job.method,
    headers: headersFromJson(job.headersJson),
    ...(body && body.byteLength > 0 ? { body } : {}),
  });
  logger.info("egress_request_delivered", {
    profile: job.profile,
    profileId,
    source: received.context.source,
    subject: received.context.subject,
    delegates: received.context.delegates,
    status: response.status,
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    body: await response.arrayBuffer(),
  };
};
