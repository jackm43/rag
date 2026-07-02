import { runAskCommand } from "./ask";
import { stringOption } from "./context";
import { runRagCommand, runRagCommandInline } from "./rag";
import { runRagboardCommand } from "./ragboard";
import { runRaghammerCommand, TIMEFRAME_FORMAT_MESSAGE } from "./raghammer";
import { runRagspendCommand, runRagspendboardCommand } from "./ragspend";
import { runRagunbanCommand } from "./ragunban";
import { runUndoragCommand } from "./undorag";
import type { CommandSpec } from "./registry";

const USER_REQUIRED = { name: "user", message: "A user mention is required." };

// The whole command surface, declaratively. The shared pre-flight chain in
// registry.ts handles option validation, interaction credentials, admin
// gating, and AI usage limits; specs only describe what is left.
export const commandSpecs: CommandSpec[] = [
  {
    name: "rag",
    kind: "deferred-inline",
    requiredOptions: [USER_REQUIRED],
    run: runRagCommand,
    failureMessage: "Command failed. Try again.",
    logEvent: "rag_command_failed",
    onMissingCredentials: runRagCommandInline,
  },
  {
    name: "ragboard",
    kind: "inline",
    run: (_ctx, env) => runRagboardCommand(env),
  },
  {
    name: "ragspend",
    kind: "inline",
    run: runRagspendCommand,
  },
  {
    name: "ragspendboard",
    kind: "inline",
    run: (_ctx, env) => runRagspendboardCommand(env),
  },
  {
    name: "raghammer",
    kind: "inline",
    adminOnly: true,
    requiredOptions: [USER_REQUIRED, { name: "timeframe", message: TIMEFRAME_FORMAT_MESSAGE }],
    run: runRaghammerCommand,
  },
  {
    name: "ragunban",
    kind: "inline",
    adminOnly: true,
    requiredOptions: [USER_REQUIRED],
    run: runRagunbanCommand,
  },
  {
    name: "undorag",
    kind: "inline",
    adminOnly: true,
    requiredOptions: [USER_REQUIRED],
    run: runUndoragCommand,
  },
  {
    name: "ask",
    kind: "deferred-inline",
    requiredOptions: [{ name: "prompt", message: "A question is required." }],
    limitKind: "ask",
    run: runAskCommand,
    failureMessage: "Could not start that AI thread. Try again.",
    logEvent: "ask_command_failed",
  },
  {
    name: "bicture",
    kind: "enqueue",
    requiredOptions: [{ name: "prompt", message: "An image prompt is required." }],
    limitKind: "bicture",
    buildJob: (ctx) => ({
      kind: "bicture",
      applicationId: ctx.applicationId,
      interactionToken: ctx.interactionToken,
      channelId: ctx.channelId,
      requesterUserId: ctx.invoker?.id,
      requesterUsername: ctx.displayName,
      prompt: stringOption(ctx, "prompt"),
    }),
  },
  {
    name: "ragjam",
    kind: "enqueue",
    requiredOptions: [{ name: "prompt", message: "A music prompt is required." }],
    limitKind: "ragjam",
    buildJob: (ctx) => {
      const lyrics = stringOption(ctx, "lyrics");
      return {
        kind: "ragjam",
        applicationId: ctx.applicationId,
        interactionToken: ctx.interactionToken,
        channelId: ctx.channelId,
        requesterUserId: ctx.invoker?.id,
        requesterUsername: ctx.displayName,
        prompt: stringOption(ctx, "prompt"),
        ...(lyrics ? { lyrics } : {}),
      };
    },
  },
];
