import type { MachinePrincipal } from "../auth";
import type { EgressProfileConfig } from "./config";

// Bundled default egress profiles. NOTHING seeds the EgressControl Durable
// Object on a fresh deploy, so its per-caller storage starts empty. These
// committed defaults let the egress worker serve every application caller's
// known profiles before any DO seeding happens. A DO-stored profile always
// wins over the bundled default for the same (caller, profile) pair (see
// requireProfile in server.ts) — the defaults are only the fallback.
//
// Keyed caller-then-profile exactly the way requireProfile looks them up
// (`DEFAULT_EGRESS_PROFILES[caller]?.[profile]`). Only the callers/profiles
// that actually route outbound HTTP through egress appear here. Deliberately
// absent: the credential broker's per-connector provider hosts and the
// secrets module's Vault backend, which stay on direct boundary clients
// because their hosts are dynamic per-registration/per-deployment and the
// calls are credentialed (a wildcard-host egress profile would be a security
// regression). See packages/connectors/handler.ts and
// packages/secrets/providers/hashicorp-vault.ts.
export const DEFAULT_EGRESS_PROFILES: Partial<
  Record<MachinePrincipal, Record<string, EgressProfileConfig>>
> = {
  responder: {
    "discord-rest": {
      identity: "discord-rest",
      allowedCallers: ["responder", "workflows"],
      allowedHosts: ["discord.com"],
      credential: { header: "authorization", env: "DISCORD_BOT_TOKEN", prefix: "Bot " },
      timeoutMs: 15_000,
    },
    "discord-webhook": {
      identity: "discord-webhook",
      allowedCallers: ["responder", "workflows"],
      allowedHosts: ["discord.com"],
      timeoutMs: 15_000,
      logPath: false,
    },
  },
  workflows: {
    "discord-rest": {
      identity: "discord-rest",
      allowedCallers: ["responder", "workflows"],
      allowedHosts: ["discord.com"],
      credential: { header: "authorization", env: "DISCORD_BOT_TOKEN", prefix: "Bot " },
      timeoutMs: 15_000,
    },
    "discord-webhook": {
      identity: "discord-webhook",
      allowedCallers: ["responder", "workflows"],
      allowedHosts: ["discord.com"],
      timeoutMs: 15_000,
      logPath: false,
    },
    "media-download": {
      identity: "media-download",
      allowedCallers: ["workflows"],
      // Wildcard sentinel: the only single-entry ["*"] host list, mapped to
      // boundary-client's "*" wildcard in server.ts's policyFor. Acceptable
      // ONLY because media-download is uncredentialed.
      allowedHosts: ["*"],
      timeoutMs: 30_000,
      maxResponseBytes: 25 * 1024 * 1024,
      logPath: false,
    },
    "ai-gateway": {
      identity: "ai-gateway",
      allowedCallers: ["workflows"],
      allowedHosts: ["gateway.ai.cloudflare.com"],
      credential: { header: "cf-aig-authorization", env: "CF_AIG_TOKEN", prefix: "Bearer " },
      timeoutMs: 120_000,
    },
  },
  spend: {
    "cloudflare-api": {
      identity: "cloudflare-api",
      allowedCallers: ["spend"],
      allowedHosts: ["api.cloudflare.com"],
      credential: { header: "authorization", env: "CLOUDFLARE_API_TOKEN", prefix: "Bearer " },
      timeoutMs: 30_000,
    },
  },
};
