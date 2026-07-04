import { logger } from "@rag/logger";
import type { DiscordInteraction, Env } from "../../../contracts";
import { buildCommandContext } from "./context";
import type { CredentialedCommandContext } from "./registry";
import { runDeferredReply } from "./deferred";
import { commandSpecs } from "./specs";

const registry = new Map(commandSpecs.map((spec) => [spec.name, spec] as const));

// Runs a deferred-inline command by name to completion and edits the original
// interaction response as `workflows`. Shared by the InteractionSession Durable
// Object (the production path) and the test harness's in-process
// INTERACTION_SESSION stub, so both exercise the identical dispatch. The
// interaction credentials are guaranteed by the ingress pre-flight; the caller
// (the DO) enforces once-only execution.
export const runDeferredCommandByName = async (
  interaction: DiscordInteraction,
  commandName: string,
  env: Env,
): Promise<void> => {
  const spec = registry.get(commandName);
  if (!spec || spec.kind !== "deferred-inline") {
    logger.error("session_deferred_command_unknown", { commandName });
    return;
  }

  const ctx = buildCommandContext(interaction) as CredentialedCommandContext;
  await runDeferredReply(interaction, env, {
    run: () => spec.run(ctx, env),
    failureMessage: spec.failureMessage,
    logEvent: spec.logEvent,
  });
};
