import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

// Stub — the real Discord gateway Durable Object is ported in Task 6. This
// exists so wrangler/vitest can resolve the DISCORD_GATEWAY binding.
export class DiscordGateway extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  }
}
