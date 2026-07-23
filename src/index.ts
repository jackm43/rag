import type { Env } from "./env";

export { DiscordGateway } from "./structs/gateway";

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // No-op for now; real sweep logic ported in a later task.
  },
} satisfies ExportedHandler<Env>;
