import { createServiceServer, registryEntities } from "@rag/service-kit";
import { authorize } from "@rag/authz/authorize";
import { decodeDevProxyCommandEnvelope } from "@rag/connectors/contracts";
import { APPLICATION_COMMAND, type DiscordInteraction, type Env } from "../../contracts";
import { type DevProxyResult } from "@rag/connectors/contracts";
import { type ServiceMessageBytes } from "@rag/contracts-core";
import { errorMessage, logger } from "@rag/logger";
import { routeInteraction } from "./commands/router";

// The ragbot-side ingress for the dev-proxy: the body of the gateway's DevProxy
// service-binding entrypoint. It is the SECOND half of a two-party gate. The
// first half is the platform + the dev-proxy worker: a service binding is
// invocable only by a worker configured with it, so this code is reachable only
// from the dev-proxy, and the dev-proxy has already terminated the untrusted
// browser (Cloudflare Access + a Better Auth Discord session) before it minted
// the token that arrives here.
//
// This function authorizes and dispatches in strict fail-closed order, reusing
// the existing machinery at every step rather than reinventing it:
//
//   1. createServiceServer verification — the SAME pipeline every service hop
//      uses: verify the identity-context token (Ed25519 signature, aud ==
//      gateway, iss == dev-proxy, exp/iat window, envelope-hash binding),
//      refuse any operation but the gateway's one registered service operation
//      (devproxy.command), and Cedar service.invoke for the dev-proxy app. This
//      authenticates the APPLICATION.
//   2. Acting-subject allowlist — the decoded payload names the Discord user
//      the command runs as; it must appear in DEV_PROXY_ALLOWED_SUBJECTS, so a
//      dev-proxy call can only ever act as a pre-approved subject (fail closed:
//      unset/empty denies all). This bounds impersonation independently of who
//      passed Access upstream.
//   3. Cedar gateway.devproxy.invoke — the app-level management-plane
//      capability surface: which command operations the dev application may
//      proxy at all (gateway.cedar), evaluated with the Application principal.
//   4. The ordinary command pre-flight — routeInteraction → executeCommand runs
//      the guild allowlist, per-user Cedar command.* authorization, raghammer
//      ban, and usage limits, EXACTLY as a Discord-initiated command would. A
//      dev-proxy command is therefore authorized identically to a real one, and
//      additionally bounded by steps 2–3.
//
// Any failure returns a bare status with no internal detail (denials never leak
// which gate refused), and nothing reaches domain code until every gate passes.

// A denial result carries no reason: the boundary already logged it, and the
// browser is untrusted, so we never disclose which gate refused.
const DENIAL_MESSAGE: Record<number, string> = {
  401: "unauthenticated",
  403: "forbidden",
  500: "error",
};

const denied = (status: number): DevProxyResult => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ error: DENIAL_MESSAGE[status] ?? "error" }),
});

const toResult = async (response: Response): Promise<DevProxyResult> => ({
  status: response.status,
  contentType: response.headers.get("content-type") ?? "application/json",
  body: await response.text(),
});

// Parse the comma-separated allowlist; blanks are ignored. An unset or empty
// value yields an empty set, which denies every subject (fail closed).
const allowedSubjects = (env: Env): Set<string> =>
  new Set(
    (env.DEV_PROXY_ALLOWED_SUBJECTS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

// Rebuild a Discord interaction from the proxied command so the existing
// command router can run unchanged. The acting subject becomes the interaction
// invoker; options are replayed verbatim (their values were length-capped at
// decode). Only APPLICATION_COMMAND is ever synthesized — the dev-proxy cannot
// forge a PING or any other interaction type.
const asInteraction = (
  command: string,
  subjectUserId: string,
  subjectUsername: string | undefined,
  guildId: string | undefined,
  channelId: string | undefined,
  applicationId: string | undefined,
  interactionToken: string | undefined,
  options: Array<{ name: string; value: string }>,
): DiscordInteraction => ({
  type: APPLICATION_COMMAND,
  ...(applicationId !== undefined ? { application_id: applicationId } : {}),
  ...(guildId !== undefined ? { guild_id: guildId } : {}),
  ...(channelId !== undefined ? { channel_id: channelId } : {}),
  ...(interactionToken !== undefined ? { token: interactionToken } : {}),
  data: {
    name: command,
    options: options.map((option) => ({ name: option.name, value: option.value })),
  },
  member: {
    user: { id: subjectUserId, username: subjectUsername ?? subjectUserId },
  },
});

export const handleDevProxyCommand = async (
  message: ServiceMessageBytes,
  env: Env,
  ctx: ExecutionContext,
): Promise<DevProxyResult> => {
  // Step 1: verify + registration gate + Cedar service.invoke, over the binding
  // transport. A null result means the boundary already logged the denial.
  const server = createServiceServer({ self: "gateway", expectedIssuers: ["dev-proxy"], env });
  const received = await server.receive(message, decodeDevProxyCommandEnvelope, "binding");
  if (!received) {
    return denied(401);
  }

  const job = received.payload;

  // Step 2: the acting Discord subject must be pre-approved.
  if (!allowedSubjects(env).has(job.subjectUserId)) {
    logger.warn("devproxy_denied", {
      reason: "subject_not_allowed",
      command: job.command,
      // The token `sub` the dev-proxy authenticated for — now the acting Discord
      // id from the Better Auth session (was the CF-Access subject under the old
      // DPoP flow). Logged for audit; the allowlist above is the trust check.
      session: received.context.subject,
    });
    return denied(403);
  }

  // Step 3: app-level capability surface (which commands may be proxied).
  const capability = authorize(
    {
      principal: { type: "Application", id: "dev-proxy" },
      action: "gateway.devproxy.invoke",
      resource: { type: "Gateway", id: "devproxy" },
      context: { command: job.command },
    },
    await registryEntities(env),
  );
  if (!capability.allowed) {
    logger.warn("devproxy_denied", { reason: "command_not_proxiable", command: job.command });
    return denied(403);
  }

  // Step 4: the ordinary command pre-flight + dispatch, identical to Discord.
  const interaction = asInteraction(
    job.command,
    job.subjectUserId,
    job.subjectUsername,
    job.guildId,
    job.channelId,
    job.applicationId,
    job.interactionToken,
    job.options,
  );
  try {
    // Synchronous execution: the dev-proxy has no Discord interaction to defer
    // against, so deferred-inline commands run to completion and return their
    // real result to the caller, and async-only (enqueue) commands are refused
    // rather than silently lost. This is why no synthetic interaction token is
    // needed or minted upstream.
    const response = await routeInteraction(interaction, env, ctx, { synchronous: true });
    return toResult(response);
  } catch (error) {
    // Fail closed on any dispatch error: return a bare 500 rather than let the
    // RPC reject with a stack the untrusted browser could observe.
    logger.error("devproxy_dispatch_failed", { command: job.command, error: errorMessage(error) });
    return denied(500);
  }
};
