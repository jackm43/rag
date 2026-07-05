import { base64Of, createEdgeWorker, jsonResponse, pathPattern, readCappedBody } from "@rag/edge-kit";
import {
  DISCORD_INTERACTION_DEFERRED_MESSAGE,
  DISCORD_INTERACTION_PING,
  DISCORD_INTERACTION_PONG,
  verifyDiscordSignature,
} from "@rag/auth-kit/discord";
import { CONNECTOR_ID_PATTERN, encodeWebhookEventEnvelope, MAX_WEBHOOK_BODY_BYTES, MAX_WEBHOOK_EVENT_TYPE_LENGTH } from "@rag/discord/contracts";
import type { WebhookEventProvider } from "@rag/discord/contracts";
import type { Env } from "../contracts";
import { errorMessage, logger } from "@rag/logger";
import { WebhookDedupe } from "./dedupe";
import { OPENAPI } from "./openapi";

export { WebhookDedupe };

// The centralised webhook-ingress worker (webhooks.jsmunro.me): the inbound
// mirror of authorizedFetch. Third-party providers POST signed deliveries to
// /{provider}/{id}; this worker reads the RAW body, hands the AUTH service the
// signature headers + exact bytes (verifyWebhook), and gets back only a boolean — it NEVER sees a
// webhook secret. A valid, first-seen event is framed as a webhook.event
// envelope and enqueued to the workflows worker; everything else exits with a bare
// status. The handler is enqueue-only and fast: providers retry on
// non-2xx/timeout, so no slow work runs inline, and no raw body or signature
// material is ever logged.
//
// How long a returned event id blocks redelivery. GitHub has no signed
// timestamp, so this dedupe window IS the GitHub replay control (see dedupe.ts
// for the honest caveats).
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

// The headers the github scheme consumes plus the event-id/type carriers,
// lowercased. ONLY these are forwarded to the auth service — a filtered set, so
// arbitrary caller headers never ride into the verify hop.
const SIGNATURE_HEADERS: Record<WebhookEventProvider, readonly string[]> = {
  github: ["x-hub-signature-256", "x-github-delivery", "x-github-event"],
};

// POST /{provider}/{id}: {provider} is the signature-scheme allowlist, {id} the
// connector slug. Anything else on this hostname does not exist.
const WEBHOOK_PATH_PATTERN = /^\/(github)\/([a-z][a-z0-9-]{0,63})$/;

// POST /{clientId}/interactions: the platform ingress for Discord interaction
// callbacks (commands, components, modals). {clientId} is the registered
// application/client id; it resolves to that app's Ed25519 public key. The
// signature IS the authentication (Discord cannot pass a Cloudflare Access
// ceremony), so this path is Access-bypassed — see wrangler.jsonc.
const INTERACTIONS_PATH_PATTERN = /^\/([A-Za-z0-9._-]{1,128})\/interactions$/;

const notFound = () => new Response("Not found", { status: 404 });
// Invalid or unverifiable deliveries all exit here with no detail — the broker
// logged the actual reason (bad signature, no configured secret); a forger learns only that it failed.
const unauthorized = () => new Response("Bad request signature", { status: 401 });

const collectSignatureHeaders = (
  request: Request,
  provider: WebhookEventProvider,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const name of SIGNATURE_HEADERS[provider]) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers[name] = value;
    }
  }
  return headers;
};

const handleWebhook = async (
  request: Request,
  env: Env,
  provider: WebhookEventProvider,
  connectorId: string,
): Promise<Response> => {
  // Cap the raw body before and after buffering, mirroring the encode-side
  // MAX_WEBHOOK_BODY_BYTES constraint so an accepted delivery always fits the
  // queue envelope.
  const body = await readCappedBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (body instanceof Response) {
    return body;
  }
  const bodyBase64 = base64Of(body);

  // Signature verification is delegated to the AUTH service (verifyWebhook): the
  // provider secret and the HMAC computation stay on the auth worker; this worker
  // learns only { valid, eventId? }. ANY failure — an invalid signature or a
  // failed hop — exits 401, fail closed.
  let verification: { valid: boolean; eventId?: string } | undefined;
  try {
    verification = await env.AUTH.verifyWebhook({
      provider,
      signatureHeaders: collectSignatureHeaders(request, provider),
      bodyBase64,
    });
  } catch (error) {
    // Never the body or headers — only that the hop itself failed.
    logger.error("webhook_verify_hop_failed", { connectorId, provider, error: errorMessage(error) });
    return unauthorized();
  }
  if (!verification?.valid) {
    return unauthorized();
  }

  // Idempotency: dedupe on the BROKER-RETURNED event id (present only on a
  // valid signature, so an attacker-chosen id can never mask a real event).
  // A duplicate is acked 200 without re-enqueueing — providers treat it as
  // delivered and stop retrying. An event with no id cannot be deduped and is
  // enqueued as-is. A missing store
  // binding is a deploy misconfiguration and fails CLOSED (500, retryable)
  // rather than silently dropping the replay control.
  if (verification.eventId !== undefined) {
    if (!env.WEBHOOK_DEDUPE) {
      logger.error("webhook_dedupe_unbound", { connectorId, provider });
      return new Response("Internal error", { status: 500 });
    }
    const dedupe = env.WEBHOOK_DEDUPE.get(env.WEBHOOK_DEDUPE.idFromName(connectorId));
    if (!(await dedupe.firstSeen(verification.eventId, DEDUPE_TTL_MS))) {
      return new Response("OK", { status: 200 });
    }
  }

  // GitHub names the event kind in a header.
  const eventTypeHeader = request.headers.get("x-github-event");
  const eventType =
    eventTypeHeader !== null &&
    eventTypeHeader.length > 0 &&
    eventTypeHeader.length <= MAX_WEBHOOK_EVENT_TYPE_LENGTH
      ? eventTypeHeader
      : undefined;

  if (!env.WEBHOOK_JOBS) {
    logger.error("webhook_jobs_unbound", { connectorId, provider });
    return new Response("Internal error", { status: 500 });
  }
  // Frame the verified event and enqueue it to the workflows worker over the SAME
  // on-behalf-of hop shape as gateway→workflows (edge → application, Cedar-gated,
  // token bound to the envelope bytes). Enqueue failures are 500 so the
  // provider retries the delivery.
  try {
    await env.WEBHOOK_JOBS.send(
      encodeWebhookEventEnvelope(
        {
          kind: "webhook.event",
          connectorId,
          provider,
          ...(verification.eventId !== undefined ? { eventId: verification.eventId } : {}),
          ...(eventType !== undefined ? { eventType } : {}),
          receivedAt: new Date().toISOString(),
          bodyBase64,
        },
        { source: "worker" },
      ),
      { contentType: "bytes" },
    );
  } catch (error) {
    logger.error("webhook_enqueue_failed", { connectorId, provider, error: errorMessage(error) });
    return new Response("Internal error", { status: 500 });
  }
  return new Response("Accepted", { status: 202 });
};

// The application's Ed25519 public key for {clientId}, from the embedded
// DISCORD_INTERACTION_PUBLIC_KEYS map. Malformed JSON or an unregistered client
// id resolves to undefined and the request 404s — an unknown app is not served.
const resolveDiscordPublicKey = (env: Env, clientId: string): string | undefined => {
  const raw = env.DISCORD_INTERACTION_PUBLIC_KEYS;
  if (!raw) {
    return undefined;
  }
  let map: unknown;
  try {
    map = JSON.parse(raw);
  } catch {
    logger.error("discord_public_keys_unparseable");
    return undefined;
  }
  if (typeof map !== "object" || map === null) {
    return undefined;
  }
  const value = (map as Record<string, unknown>)[clientId];
  return typeof value === "string" ? value : undefined;
};

// POST /{clientId}/interactions: verify the Discord Ed25519 signature with the
// app's public key, then — PING -> type-1 PONG (Discord's endpoint-validation
// probe); anything else -> return the type-5 deferred ack and kick the
// InteractionSession DO, which owns the full command dispatch. Verify + ack is
// well within Discord's 3s budget (Ed25519 is fast; the DO kick rides
// waitUntil). No bot domain code runs here: the verified interaction is handed
// to the DO as an opaque payload.
const handleInteractions = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  clientId: string,
): Promise<Response> => {
  const publicKey = resolveDiscordPublicKey(env, clientId);
  if (!publicKey) {
    return notFound();
  }

  const interaction = await verifyDiscordSignature(request, publicKey);
  if (interaction === null) {
    return unauthorized();
  }

  const type = (interaction as { type?: unknown }).type;
  if (type === DISCORD_INTERACTION_PING) {
    return jsonResponse(200, { type: DISCORD_INTERACTION_PONG });
  }

  const token = (interaction as { token?: unknown }).token;
  if (typeof token !== "string" || token.length === 0) {
    return unauthorized();
  }

  if (!env.INTERACTION_SESSION) {
    // A deploy misconfiguration: the cross-script DO binding is absent. Fail
    // with a retryable 500 rather than silently dropping the interaction.
    logger.error("interaction_session_unbound", { clientId });
    return new Response("Internal error", { status: 500 });
  }

  ctx.waitUntil(
    env.INTERACTION_SESSION.get(env.INTERACTION_SESSION.idFromName(token)).run(interaction),
  );
  return jsonResponse(200, { type: DISCORD_INTERACTION_DEFERRED_MESSAGE });
};

export default createEdgeWorker<Env>({
  service: "webhooks",
  openapi: OPENAPI,
  routes: [
    {
      match: pathPattern(WEBHOOK_PATH_PATTERN),
      methods: {
        POST: (request, env, _ctx, [provider, connectorId]) => {
          // Defense in depth: the path pattern already enforces the slug
          // shape, but the shared CONNECTOR_ID_PATTERN stays the single
          // authority.
          if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
            return notFound();
          }
          return handleWebhook(request, env, provider as WebhookEventProvider, connectorId);
        },
      },
    },
    {
      match: pathPattern(INTERACTIONS_PATH_PATTERN),
      methods: {
        POST: (request, env, ctx, [clientId]) => handleInteractions(request, env, ctx, clientId),
      },
    },
  ],
});
