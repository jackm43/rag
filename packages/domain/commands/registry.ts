import type { InteractionMessageData, InteractionResponseFile } from "../../discord";
import { encodeAiJobEnvelope } from "../../contracts";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  type AiJob,
  type DiscordInteraction,
  type Env,
} from "../../contracts/types";
import { isRagAdminUser } from "../admins";
import { activeAiBanForUser, aiBanMessage } from "../bans";
import { jsonResponse } from "../http";
import { checkAiUsageAllowed } from "../limits";
import { buildCommandContext, hasOption, type CommandContext } from "./context";
import { handleDeferredInteraction } from "./deferred";

// A context whose interaction credentials have been verified by the shared
// pre-flight chain, so enqueue/deferred specs can rely on them.
export type CredentialedCommandContext = CommandContext & {
  applicationId: string;
  interactionToken: string;
};

export type RequiredOption = {
  name: string;
  message: string;
};

type DeferredRunResult =
  | InteractionMessageData
  | { data: InteractionMessageData; files: InteractionResponseFile[] };

type CommandSpecBase = {
  name: string;
  requiredOptions?: RequiredOption[];
  limitKind?: string;
  adminOnly?: boolean;
};

// The three command shapes:
// - "enqueue": defer immediately and hand a job to the AI queue.
// - "inline": answer synchronously from the interaction handler.
// - "deferred-inline": defer, run in waitUntil, edit the original response.
export type CommandSpec = CommandSpecBase &
  (
    | {
        kind: "enqueue";
        buildJob: (ctx: CredentialedCommandContext) => AiJob;
      }
    | {
        kind: "inline";
        run: (ctx: CommandContext, env: Env) => Response | Promise<Response>;
      }
    | {
        kind: "deferred-inline";
        run: (ctx: CredentialedCommandContext, env: Env) => Promise<DeferredRunResult>;
        failureMessage: string;
        logEvent: string;
        onMissingCredentials?: (ctx: CommandContext, env: Env) => Response | Promise<Response>;
      }
  );

const inlineMessage = (content: string) =>
  jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, allowed_mentions: { parse: [] } },
  });

const hasCredentials = (ctx: CommandContext): ctx is CredentialedCommandContext =>
  Boolean(ctx.applicationId && ctx.interactionToken);

// Shared pre-flight chain: option validation -> interaction credentials ->
// admin check -> raghammer ban (AI commands) -> usage limits -> dispatch
// (enqueue+defer, inline, or defer+run). Every command goes through the same
// guards in the same order.
export const executeCommand = async (
  spec: CommandSpec,
  interaction: DiscordInteraction,
  env: Env,
  executionCtx: ExecutionContext,
): Promise<Response> => {
  const ctx = buildCommandContext(interaction);

  for (const option of spec.requiredOptions ?? []) {
    if (!hasOption(ctx, option.name)) {
      return inlineMessage(option.message);
    }
  }

  if (spec.kind !== "inline" && !hasCredentials(ctx)) {
    if (spec.kind === "deferred-inline" && spec.onMissingCredentials) {
      return spec.onMissingCredentials(ctx, env);
    }
    return inlineMessage(`Could not defer /${spec.name} without interaction credentials.`);
  }

  if (spec.adminOnly && !isRagAdminUser(ctx.invoker?.id)) {
    return inlineMessage(`You are not allowed to use /${spec.name}.`);
  }

  if (spec.limitKind) {
    if (ctx.invoker) {
      const activeBan = await activeAiBanForUser(env, ctx.invoker.id, new Date());
      if (activeBan) {
        return inlineMessage(aiBanMessage(activeBan.expires_at));
      }
    }

    const usage = await checkAiUsageAllowed(env, ctx.invoker?.id, spec.limitKind);
    if (!usage.allowed) {
      return inlineMessage(usage.message);
    }
  }

  if (spec.kind === "inline") {
    return spec.run(ctx, env);
  }

  if (!hasCredentials(ctx)) {
    // Unreachable: guarded above. Narrows the type for the calls below.
    return inlineMessage(`Could not defer /${spec.name} without interaction credentials.`);
  }

  if (spec.kind === "enqueue") {
    await env.AI_JOBS.send(
      encodeAiJobEnvelope(spec.buildJob(ctx), {
        source: "interactions",
        guildId: ctx.guildId,
      }),
    );
    return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
  }

  return handleDeferredInteraction(interaction, env, executionCtx, {
    run: () => spec.run(ctx, env),
    failureMessage: spec.failureMessage,
    logEvent: spec.logEvent,
    onMissingCredentials: () =>
      inlineMessage(`Could not defer /${spec.name} without interaction credentials.`),
  });
};
