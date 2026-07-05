import {
  createBoundaryClient,
  type BoundaryCredential,
  type BoundaryFetch,
  type BoundaryPolicy,
  type EgressIdentityZone,
} from "./boundary-client";
import { isEgressProfileConfig, type EgressProfileConfig } from "./config";
import { DEFAULT_EGRESS_PROFILES } from "./profiles";

// Outbound HTTP happens IN-PROCESS: a worker that needs to make an outbound call
// builds a boundary client for a named (caller, profile) and fetches directly.
// There is no egress sidecar worker and no RPC hop — the profile owns the host
// allowlist, timeout, size caps and credential injection, and the credential is
// resolved from THIS worker's env. Trust is that the worker only builds profiles
// it is an allowed caller of; a profile it doesn't own throws.

export type EgressCaller = "responder" | "workflows" | "spend";

// Retained for call-site compatibility (an optional acting subject); unused now
// that outbound is in-process and carries no identity token.
export type EgressFetchOptions = { subject?: { sub: string } };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

const zoneForProfile = (profile: string): EgressIdentityZone => {
  if (profile === "discord-rest" || profile === "discord-webhook") return "egress-discord";
  if (profile === "cloudflare-api") return "egress-cloudflare-api";
  if (profile === "media-download") return "egress-media";
  if (profile === "ai-gateway") return "egress-ai-gateway";
  return "egress-connector";
};

const credentialFor = (
  env: Record<string, unknown>,
  config: EgressProfileConfig,
): BoundaryCredential | undefined => {
  if (!config.credential) return undefined;
  const value = env[config.credential.env];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Egress credential ${config.credential.env} is not configured`);
  }
  return { header: config.credential.header, value: `${config.credential.prefix ?? ""}${value}` };
};

const policyFor = (
  env: Record<string, unknown>,
  profile: string,
  config: EgressProfileConfig,
): BoundaryPolicy => ({
  identity: config.identity ?? profile,
  trustZone: zoneForProfile(profile),
  credential: credentialFor(env, config),
  allowedHosts:
    config.allowedHosts.length === 1 && config.allowedHosts[0] === "*" ? "*" : config.allowedHosts,
  defaultTimeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  logPath: config.logPath ?? profile !== "discord-webhook",
});

// A `fetch`-shaped outbound client for a named (caller, profile), resolved from
// the bundled profiles and this worker's credentials. Fails closed on an unknown
// or unauthorized profile.
export const createEgressClient = (
  env: unknown,
  profile: string,
  caller: EgressCaller,
): BoundaryFetch => {
  const config = DEFAULT_EGRESS_PROFILES[caller]?.[profile];
  if (!isEgressProfileConfig(config)) {
    throw new Error(`Unknown egress profile: ${caller}:${profile}`);
  }
  if (!config.allowedCallers.includes(caller)) {
    throw new Error(`Egress profile denied: ${caller}:${profile}`);
  }
  return createBoundaryClient(policyFor(env as Record<string, unknown>, profile, config));
};
