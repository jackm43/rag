import type { InteractionMessageData, InteractionResponseFile } from "../../discord";
import { serviceClients, SYSTEM_SUBJECT } from "../../auth";
import { encodeAiJobEnvelope } from "../../contracts";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  type AiJob,
  type DiscordInteraction,
  type Env,
} from "../../contracts/types";
import { authorize } from "../../authz/authorize";
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
// Cedar authorization (admin gate + raghammer ban) -> usage limits ->
// dispatch (enqueue+defer, inline, or defer+run). Every command goes through
// the same guards in the same order.
// How the command was invoked. "discord" is the normal path (defer + edit the
// interaction). "synchronous" is the dev-proxy path: there is no Discord
// interaction to defer against, so deferred-inline commands run to completion
// and their real result is returned in the response. Commands that can only
// deliver asynchronously (enqueue) are not available synchronously — the
// dev-proxy capability policy (devproxy.cedar) also withholds them, so this is
// a defensive fallback, never the primary gate.
export type CommandExecution = { synchronous?: boolean };

export const executeCommand = async (
  spec: CommandSpec,
  interaction: DiscordInteraction,
  env: Env,
  executionCtx: ExecutionContext,
  execution: CommandExecution = {},
): Promise<Response> => {
  const ctx = buildCommandContext(interaction);

  for (const option of spec.requiredOptions ?? []) {
    if (!hasOption(ctx, option.name)) {
      return inlineMessage(option.message);
    }
  }

  // A synchronous invocation never defers, so it needs no interaction
  // credentials; only the Discord path requires them to edit the response.
  if (!execution.synchronous && spec.kind !== "inline" && !hasCredentials(ctx)) {
    if (spec.kind === "deferred-inline" && spec.onMissingCredentials) {
      return spec.onMissingCredentials(ctx, env);
    }
    return inlineMessage(`Could not defer /${spec.name} without interaction credentials.`);
  }

  // One policy decision per command: Cedar evaluates the admin gate and the
  // raghammer ban together. The ban state itself still comes from D1, and
  // only AI-limited commands pay for the lookup, exactly as before.
  const activeBan =
    spec.limitKind && ctx.invoker
      ? await activeAiBanForUser(env, ctx.invoker.id, new Date())
      : null;
  const decision = authorize({
    principal: { type: "Human", id: ctx.invoker?.id ?? "unknown" },
    action: `command.${spec.name}`,
    resource: { type: "Guild", id: ctx.guildId ?? "unknown" },
    context: { banned: activeBan !== null },
  });
  if (!decision.allowed) {
    if (activeBan) {
      return inlineMessage(aiBanMessage(activeBan.expires_at));
    }
    return inlineMessage(`You are not allowed to use /${spec.name}.`);
  }

  if (spec.limitKind) {
    const usage = await checkAiUsageAllowed(env, ctx.invoker?.id, spec.limitKind);
    if (!usage.allowed) {
      return inlineMessage(usage.message);
    }
  }

  if (spec.kind === "inline") {
    return spec.run(ctx, env);
  }

  // Synchronous (dev-proxy) dispatch: run to completion and return the real
  // result instead of deferring. deferred-inline runs need no credentials (see
  // above); enqueue commands deliver asynchronously to Discord and cannot round
  // trip here, so they are refused rather than silently enqueued and lost.
  if (execution.synchronous) {
    if (spec.kind === "deferred-inline") {
      const result = await spec.run(ctx as CredentialedCommandContext, env);
      const data = "data" in result ? result.data : result;
      return jsonResponse({ type: CHANNEL_MESSAGE_WITH_SOURCE, data });
    }
    return inlineMessage(
      `/${spec.name} delivers its result asynchronously to Discord and is not available over the dev proxy.`,
    );
  }

  if (!hasCredentials(ctx)) {
    // Unreachable: guarded above. Narrows the type for the calls below.
    return inlineMessage(`Could not defer /${spec.name} without interaction credentials.`);
  }

  if (spec.kind === "enqueue") {
    await serviceClients(env).gatewayToBrain.call({
      transport: "queue",
      queue: env.AI_JOBS,
      envelope: encodeAiJobEnvelope(spec.buildJob(ctx), {
        source: "interactions",
        guildId: ctx.guildId,
      }),
      subject: { sub: ctx.invoker?.id ?? SYSTEM_SUBJECT },
    });
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
