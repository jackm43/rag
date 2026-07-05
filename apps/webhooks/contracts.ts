import type { AuthGatewayBinding } from "@rag/edge-kit";

// The webhooks worker's env. It authenticates inbound deliveries at the edge
// (Discord Ed25519 inline; provider HMAC via the AUTH service), dedupes, and
// enqueues verified events to the workflows worker.
export type Env = {
  // The auth service (verifyWebhook holds the provider secrets + HMAC).
  AUTH: AuthGatewayBinding;
  // Discord application public keys for interaction-signature verification
  // (JSON {clientId: hexPubKey}).
  DISCORD_INTERACTION_PUBLIC_KEYS?: string;
  // Verified webhook events to the workflows worker (plain capnp envelope bytes).
  WEBHOOK_JOBS?: Queue<Uint8Array>;
  // TTL'd replay-dedupe store, one object per connector.
  WEBHOOK_DEDUPE?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => { firstSeen: (key: string, ttlMs: number) => Promise<boolean> };
  };
  // The bot's InteractionSession processor DO (defined by the workflows worker).
  INTERACTION_SESSION?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => { run: (interaction: unknown) => Promise<void> };
  };
};
