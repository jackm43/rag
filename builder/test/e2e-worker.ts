// Test-only entry for the local end-to-end run (test/e2e.mjs); never deployed.
// Production code calls fixed hosts. Here those two hosts are rerouted to local
// fakes, and BuilderControl is reachable over HTTP in place of the bot's
// service binding.
import worker from "../src/index";
import type { Env } from "../src/types";

export * from "../src/index";

declare const E2E_MODEL: string;
declare const E2E_DISCORD: string;

const fakes: Record<string, string> = {
  "gateway.ai.cloudflare.com": E2E_MODEL,
  "discord.com": E2E_DISCORD,
};
const realFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const fake = fakes[url.hostname];
  return realFetch(
    fake ? new Request(fake + url.pathname + url.search, request) : request,
  );
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const control = url.pathname.match(/^\/__e2e\/control\/(\w+)$/);
    if (!control) return worker.fetch(request, env);
    try {
      const builder = (ctx as unknown as { exports: Record<string, any> })
        .exports.BuilderControl;
      return Response.json(await builder[control[1]](await request.json()));
    } catch (error) {
      return Response.json(
        { error: String((error as Error).message) },
        { status: 400 },
      );
    }
  },
};
