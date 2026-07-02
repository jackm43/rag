import type { Env } from "../types";
import { createBoundaryClient, type BoundaryFetch } from "./boundary-client";

const DISCORD_TIMEOUT_MS = 15_000;
const AI_GATEWAY_TIMEOUT_MS = 120_000;
const CLOUDFLARE_API_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 30_000;
const MEDIA_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

export type BoundaryClients = {
  discordRest: BoundaryFetch;
  discordWebhook: BoundaryFetch;
  aiGateway: BoundaryFetch;
  cloudflareApi: BoundaryFetch;
  mediaDownload: BoundaryFetch;
};

const lazy = <T>(create: () => T) => {
  let value: T | undefined;
  return () => (value ??= create());
};

const buildClients = (env: Env): BoundaryClients => {
  const discordRest = lazy(() =>
    createBoundaryClient({
      identity: "discord-rest",
      trustZone: "egress-discord",
      credential: { header: "authorization", value: `Bot ${env.DISCORD_BOT_TOKEN}` },
      allowedHosts: ["discord.com"],
      defaultTimeoutMs: DISCORD_TIMEOUT_MS,
    }));
  const discordWebhook = lazy(() =>
    createBoundaryClient({
      identity: "discord-webhook",
      trustZone: "egress-discord",
      allowedHosts: ["discord.com"],
      defaultTimeoutMs: DISCORD_TIMEOUT_MS,
    }));
  const aiGateway = lazy(() => {
    if (!env.CF_AIG_TOKEN) {
      throw new Error("CF_AIG_TOKEN is required for AI Gateway requests");
    }
    return createBoundaryClient({
      identity: "ai-gateway",
      trustZone: "egress-ai-gateway",
      credential: { header: "cf-aig-authorization", value: `Bearer ${env.CF_AIG_TOKEN}` },
      allowedHosts: ["gateway.ai.cloudflare.com"],
      defaultTimeoutMs: AI_GATEWAY_TIMEOUT_MS,
    });
  });
  const cloudflareApi = lazy(() => {
    if (!env.CLOUDFLARE_API_TOKEN) {
      throw new Error("CLOUDFLARE_API_TOKEN is required for Cloudflare API requests");
    }
    return createBoundaryClient({
      identity: "cloudflare-api",
      trustZone: "egress-cloudflare-api",
      credential: { header: "authorization", value: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      allowedHosts: ["api.cloudflare.com"],
      defaultTimeoutMs: CLOUDFLARE_API_TIMEOUT_MS,
    });
  });
  const mediaDownload = lazy(() =>
    createBoundaryClient({
      identity: "media-download",
      trustZone: "egress-media",
      allowedHosts: "*",
      defaultTimeoutMs: MEDIA_TIMEOUT_MS,
      maxResponseBytes: MEDIA_MAX_RESPONSE_BYTES,
    }));

  return {
    get discordRest() {
      return discordRest();
    },
    get discordWebhook() {
      return discordWebhook();
    },
    get aiGateway() {
      return aiGateway();
    },
    get cloudflareApi() {
      return cloudflareApi();
    },
    get mediaDownload() {
      return mediaDownload();
    },
  };
};

const clientsByEnv = new WeakMap<Env, BoundaryClients>();

export const boundaryClients = (env: Env): BoundaryClients => {
  const cached = clientsByEnv.get(env);
  if (cached) {
    return cached;
  }
  const clients = buildClients(env);
  clientsByEnv.set(env, clients);
  return clients;
};
