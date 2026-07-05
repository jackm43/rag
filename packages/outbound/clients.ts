import type { BoundaryFetch } from "./boundary-client";
import { createEgressClient, type EgressCaller, type EgressFetchOptions } from "./client";

// Every application outbound HTTP client now routes through the generic egress
// sidecar worker: the credential, host allowlist, timeout and size caps live
// in the egress worker's profile (bundled defaults in packages/egress/profiles
// plus any DO-seeded overrides), never here. createEgressClient fails closed
// ("EGRESS service binding is required for bound egress") when env.EGRESS is
// absent — there is no direct-fetch fallback.
//
// AI Gateway egress is not here: model access (credential, URL construction,
// binding-vs-HTTP routing) is centralized behind apps/bot/lib/ai/inference, which
// builds its own egress client for the "ai-gateway" profile.
export type BoundaryClients = {
  discordRest: BoundaryFetch;
  discordWebhook: BoundaryFetch;
  cloudflareApi: BoundaryFetch;
  mediaDownload: BoundaryFetch;
};

const lazy = <T>(create: () => T) => {
  let value: T | undefined;
  return () => (value ??= create());
};

const buildClients = (env: unknown, caller: EgressCaller): BoundaryClients => {
  const discordRest = lazy(() => createEgressClient(env, "discord-rest", caller));
  const discordWebhook = lazy(() => createEgressClient(env, "discord-webhook", caller));
  const cloudflareApi = lazy(() => createEgressClient(env, "cloudflare-api", caller));
  const mediaDownload = lazy(() => createEgressClient(env, "media-download", caller));

  return {
    get discordRest() {
      return discordRest();
    },
    get discordWebhook() {
      return discordWebhook();
    },
    get cloudflareApi() {
      return cloudflareApi();
    },
    get mediaDownload() {
      return mediaDownload();
    },
  };
};

// Cache per env AND per caller: two workers can share an Env-shaped object in
// tests, and a client built for one caller must never be returned to another
// (the egress hop is signed with the caller's identity).
const clientsByEnv = new WeakMap<object, Map<EgressCaller, BoundaryClients>>();

export const boundaryClients = (env: unknown, caller: EgressCaller): BoundaryClients => {
  let byCaller = clientsByEnv.get(env as object);
  if (!byCaller) {
    byCaller = new Map();
    clientsByEnv.set(env as object, byCaller);
  }
  const cached = byCaller.get(caller);
  if (cached) {
    return cached;
  }
  const clients = buildClients(env, caller);
  byCaller.set(caller, clients);
  return clients;
};

export type { EgressFetchOptions, EgressCaller };
