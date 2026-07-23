import type { APIInteraction } from "discord-api-types/v10";

import type { Env } from "../env";
import { logger } from "../lib/logger";

// Stub — command dispatch is ported in Task 4. For now this just logs so the
// interactions endpoint has something to hand deferred (type 5) interactions
// off to via ctx.waitUntil.
export async function dispatch(interaction: APIInteraction, _env: Env, _ctx: ExecutionContext): Promise<void> {
  logger.info("dispatch_stub", { type: interaction.type });
}
