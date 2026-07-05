import type { InteractionMessageData, InteractionResponseFile } from "../api";
import { type AiJob, type Env } from "../contracts";
import { activeAiBanForUser, aiBanMessage } from "../domain/bans";
import { checkAiUsageAllowed } from "../domain/limits";
import { type CommandContext } from "./context";

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
      }
  );

// The command authorization gate, now plain data (Cedar removed). It mirrors the
// former policy exactly: admin commands need admin membership; a raghammer AI ban
// forbids the AI commands; AI-limited commands then pay the usage lookup. Public
// commands are open. Used by the all-deferred processor path (runInteractionSession)
// as the single authorization authority.
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
