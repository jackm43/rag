import type { InteractionMessageData, InteractionResponseFile } from "../../discord";
import { encodeAiJobEnvelope } from "../../../contracts";
import { CHANNEL_MESSAGE_WITH_SOURCE, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, type AiJob, type DiscordInteraction, type Env } from "../../../contracts";
import { activeAiBanForUser, aiBanMessage } from "../bans";
import { jsonResponse } from "../http";
import { checkAiUsageAllowed } from "../limits";
import { buildCommandContext, hasOption, type CommandContext } from "./context";

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

// The command authorization gate, now plain data (Cedar removed). It mirrors the
// former policy exactly: admin commands need admin membership; a raghammer AI ban
// forbids the AI commands; AI-limited commands then pay the usage lookup. Public
// commands are open. Shared by the synchronous gateway path (executeCommand) and
// the all-deferred processor path so there is a single authorization authority.
const ADMIN_COMMANDS = new Set(["raghammer", "ragunban", "undorag"]);
// Admin membership is data, not code — the rag-admins list. This file (not a
// policy engine) is what changes when an admin is added or removed.
export const RAG_ADMIN_USER_IDS = [
  "107426926909517824",
  "116163000339136518",
  "102637456385392640",
  "114128631474683907",
];
const ADMIN_SET = new Set(RAG_ADMIN_USER_IDS);

export const authorizeAndLimit = async (
  spec: CommandSpec,
  ctx: CommandContext,
  env: Env,
): Promise<{ allowed: true } | { allowed: false; message: string }> => {
  if (ADMIN_COMMANDS.has(spec.name) && !ADMIN_SET.has(ctx.invoker?.id ?? "")) {
    return { allowed: false, message: `You are not allowed to use /${spec.name}.` };
  }

  if (spec.limitKind && ctx.invoker) {
    const activeBan = await activeAiBanForUser(env, ctx.invoker.id, new Date());
    if (activeBan) {
      return { allowed: false, message: aiBanMessage(activeBan.expires_at) };
    }
  }

  if (spec.limitKind) {
    const usage = await checkAiUsageAllowed(env, ctx.invoker?.id, spec.limitKind);
    if (!usage.allowed) {
      return { allowed: false, message: usage.message };
    }
  }

  return { allowed: true };
};

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

  const gate = await authorizeAndLimit(spec, ctx, env);
  if (!gate.allowed) {
    return inlineMessage(gate.message);
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
    // Plain capnp envelope over the trusted gateway -> workflows ai-jobs queue.
    await env.AI_JOBS.send(
      encodeAiJobEnvelope(spec.buildJob(ctx), { source: "interactions", guildId: ctx.guildId }),
      { contentType: "bytes" },
    );
    return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
  }

  // deferred-inline: return the type-5 ack now; the InteractionSession DO in the
  // workflows worker runs the handler and edits the response as `workflows`. The
  // gateway ingress holds neither the EGRESS binding nor WORKFLOWS_SIGNING_KEY,
  // so the outbound edit cannot be sent from here. The kick rides waitUntil so
  // the 3-second ack is never delayed by the DO round-trip.
  executionCtx.waitUntil(
    env.INTERACTION_SESSION
      .get(env.INTERACTION_SESSION.idFromName(ctx.interactionToken))
      .runDeferredCommand(interaction, spec.name),
  );
  return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
