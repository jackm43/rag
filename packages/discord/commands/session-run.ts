import { editOriginalInteractionResponse, type InteractionMessageData } from "../api";
import { errorMessage, logger } from "@rag/logger";
import { APPLICATION_COMMAND, type AiJob, type DiscordInteraction, type Env } from "../contracts";
import { processBictureJob } from "./bicture";
import { processRagjamJob } from "./ragjam";
import { GUILD_NOT_ALLOWED_MESSAGE, isGuildAllowed } from "../domain/guilds";
import { buildCommandContext, hasOption } from "./context";
import { authorizeAndLimit, type CredentialedCommandContext } from "./registry";
import { runDeferredReply } from "./deferred";
import { commandSpecs } from "./specs";

const registry = new Map(commandSpecs.map((spec) => [spec.name, spec] as const));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Enqueue-kind commands (bicture, ragjam) normally hand a job to the AI queue,
// whose workflows consumer edits the deferred reply. The processor DO already
// runs inside the workflows worker but has no producer binding to that queue,
// so it invokes the SAME job processor in-process — the processor edits the
// deferred response itself, attributed to the requester when no request context
// is threaded.
const runEnqueueJob = async (job: AiJob, env: Env): Promise<void> => {
  switch (job.kind) {
    case "bicture":
      await processBictureJob(job, env);
      return;
    case "ragjam":
      await processRagjamJob(job, env);
      return;
    default:
      logger.error("session_enqueue_kind_unsupported", { kind: job.kind });
  }
};

// The all-deferred processor dispatch: runs the FULL command pre-flight and
// handler for a verified Discord interaction, turning every outcome into an
// edit of the already-acked deferred response, sent as the `workflows`
// principal (the only bot component holding EGRESS + WORKFLOWS_SIGNING_KEY).
// The neutral webhook ingress verifies the Discord signature, returns the
// type-5 ack, and kicks the InteractionSession DO, which calls this. Because
// the ack is already public, a rejection (guild gate, authz, limits, missing
// option) is surfaced as an edited reply rather than a synchronous type-4 —
// none of the inline commands reply ephemerally, so no visibility is lost.
// Mirrors executeCommand's chain (option validation -> Cedar authz + limits ->
// dispatch) and shares its authorizeAndLimit authority.
export const runInteractionSession = async (
  interaction: DiscordInteraction,
  env: Env,
): Promise<void> => {
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    logger.error("session_missing_interaction_credentials");
    return;
  }

  // Every terminal outcome edits the one deferred reply. Best-effort: a failed
  // edit is logged, never thrown, so the DO alarm can still reclaim storage.
  const edit = async (data: InteractionMessageData): Promise<void> => {
    try {
      await editOriginalInteractionResponse(env, "workflows", applicationId, interactionToken, data);
    } catch (error) {
      logger.error("session_interaction_edit_failed", { error: errorMessage(error) });
    }
  };
  const editText = (content: string) => edit({ content, allowed_mentions: { parse: [] } });

  if (interaction.type !== APPLICATION_COMMAND) {
    await editText("Unsupported interaction.");
    return;
  }

  if (!isGuildAllowed(env, interaction.guild_id)) {
    await editText(GUILD_NOT_ALLOWED_MESSAGE);
    return;
  }

  const spec = registry.get(interaction.data?.name ?? "");
  if (!spec) {
    await editText("Unknown command.");
    return;
  }

  const ctx = buildCommandContext(interaction) as CredentialedCommandContext;

  for (const option of spec.requiredOptions ?? []) {
    if (!hasOption(ctx, option.name)) {
      await editText(option.message);
      return;
    }
  }

  const gate = await authorizeAndLimit(spec, ctx, env);
  if (!gate.allowed) {
    await editText(gate.message);
    return;
  }

  if (spec.kind === "inline") {
    // Inline handlers return a type-4 Response; the all-deferred path edits with
    // its message data instead. Every inline handler builds it via jsonResponse
    // ({ type: 4, data }), so `.data` is the reliable payload.
    let data: InteractionMessageData;
    try {
      const body = await (await spec.run(ctx, env)).json();
      data = isRecord(body) && isRecord(body.data)
        ? (body.data as InteractionMessageData)
        : { content: "Command failed. Try again.", allowed_mentions: { parse: [] } };
    } catch (error) {
      logger.error("session_inline_command_failed", { command: spec.name, error: errorMessage(error) });
      data = { content: "Command failed. Try again.", allowed_mentions: { parse: [] } };
    }
    await edit(data);
    return;
  }

  if (spec.kind === "enqueue") {
    await runEnqueueJob(spec.buildJob(ctx), env);
    return;
  }

  // deferred-inline: runDeferredReply runs the handler and edits as `workflows`,
  // posting the spec's failure message on error.
  await runDeferredReply(interaction, env, {
    run: () => spec.run(ctx, env),
    failureMessage: spec.failureMessage,
    logEvent: spec.logEvent,
  });
};
