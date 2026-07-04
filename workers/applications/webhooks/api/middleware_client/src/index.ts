import { createClient, createHopIntent, ensureRegistered } from "../../../../../../packages/auth";
import { connectorsClient } from "../../../../../../packages/connectors";
import {
  CONNECTOR_ID_PATTERN,
  encodeWebhookEventEnvelope,
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_EVENT_TYPE_LENGTH,
} from "../../../../../../packages/contracts";
import type { Env, WebhookEventProvider } from "../../../../../../packages/contracts/types";
import { errorMessage, logger } from "../../../../../../packages/logger";
import { WEBHOOKS_MANIFEST, WebhookDedupe } from "../../../service_server/src";
import { OPENAPI } from "./openapi";

export { WebhookDedupe };

// The centralised webhook-ingress worker (webhooks.jsmunro.me): the inbound
// mirror of authorizedFetch. Third-party providers POST signed deliveries to
// /{provider}/{id}; this worker reads the RAW body, hands the broker the
// signature headers + exact bytes over the CONNECTORS binding
// (connector.webhook.verify), and gets back only a boolean — it NEVER sees a
// webhook secret. A valid, first-seen event is framed as a webhook.event
// ServiceMessage and enqueued to the workflows worker; everything else exits with a bare
// status. The handler is enqueue-only and fast: providers retry on
// non-2xx/timeout, so no slow work runs inline, and no raw body or signature
// material is ever logged.
//
// How long a broker-returned event id blocks redelivery. Stripe replays are
// additionally bounded broker-side by the signed-timestamp tolerance; GitHub
// has no signed timestamp, so this dedupe window IS the GitHub replay control
// (see dedupe.ts for the honest caveats).
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

// The headers each scheme consumes (packages/connectors/webhooks.ts) plus the
// event-id/type carriers, lowercased. ONLY these are forwarded to the broker —
// a filtered set, so arbitrary caller headers never ride into the verify hop.
const SIGNATURE_HEADERS: Record<WebhookEventProvider, readonly string[]> = {
  github: ["x-hub-signature-256", "x-github-delivery", "x-github-event"],
  stripe: ["stripe-signature"],
};

// POST /{provider}/{id}: {provider} is the signature-scheme allowlist (the
// broker re-checks it against the connector's own webhook config), {id} the
// connector slug. Anything else on this hostname does not exist.
const WEBHOOK_PATH_PATTERN = /^\/(github|stripe)\/([a-z][a-z0-9-]{0,63})$/;

const notFound = () => new Response("Not found", { status: 404 });
// Invalid or unverifiable deliveries all exit here with no detail — the broker
// audit-logged the actual reason (bad signature, unknown connector, denied
// caller); a forger learns only that it failed.
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

// Base64 the exact body bytes (signatures cover exact bytes, so the body must
// cross the verify hop without any re-encoding). Chunked to stay within
// String.fromCharCode's argument limits.
const base64Of = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const handleWebhook = async (
  request: Request,
  env: Env,
  provider: WebhookEventProvider,
  connectorId: string,
): Promise<Response> => {
  // Cap the raw body BEFORE buffering (content-length) and after (actual
  // bytes), mirroring the encode-side MAX_WEBHOOK_BODY_BYTES constraint so an
  // accepted delivery always fits the queue envelope.
  const declaredLength = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  const bodyBase64 = base64Of(body);

  // The identity subject for both hops. There is no human behind a provider
  // delivery, so the on-behalf-of subject is a synthetic ORIGIN subject naming
  // the connector the event arrived for — "webhook:{connectorId}" — the same
  // shape as SYSTEM_SUBJECT for the workflows worker's self-initiated flows, but
  // attributable per connector in the broker's and workflows worker's audit logs.
  const subject = { sub: `webhook:${connectorId}` };

  // Signature verification is the broker's connector.webhook.verify: the
  // secret and the HMAC computation stay broker-side; this worker learns only
  // { valid, eventId? }. ANY failure — a broker denial, an invalid signature,
  // or a failed hop (e.g. missing signing material) — exits 401, fail closed.
  let verification: { valid: boolean; eventId?: string } | undefined;
  try {
    const result = await connectorsClient(
      env,
      createClient({
        env,
        self: "webhooks",
        context: { subject: subject.sub },
      }).to("connectors", { transportTrust: "application" }),
    ).verifyWebhook(connectorId, {
      provider,
      signatureHeaders: collectSignatureHeaders(request, provider),
      bodyBase64,
    });
    verification = result.status === 200 ? result.webhook : undefined;
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
  // delivered and stop retrying. An event with no id (e.g. a Stripe body with
  // no parseable id) cannot be deduped and is enqueued as-is. A missing store
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

  // GitHub names the event kind in a header; Stripe's rides in the body and
  // is left to the consumer to parse.
  const eventTypeHeader = provider === "github" ? request.headers.get("x-github-event") : null;
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
    await createClient({
      env,
      self: "webhooks",
      context: { subject: subject.sub },
    }).to("workflows", { transportTrust: "application" }).call({
      transport: "queue",
      queue: env.WEBHOOK_JOBS,
      envelope: encodeWebhookEventEnvelope(
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
      intent: createHopIntent({
        action: "webhook.event",
        resourceType: "Connector",
        resourceId: connectorId,
        method: provider,
      }),
    });
  } catch (error) {
    logger.error("webhook_enqueue_failed", { connectorId, provider, error: errorMessage(error) });
    return new Response("Internal error", { status: 500 });
  }
  return new Response("Accepted", { status: 202 });
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureRegistered(env, WEBHOOKS_MANIFEST));
    const pathname = new URL(request.url).pathname;
    if (pathname === "/openapi.json" && request.method === "GET") {
      return new Response(JSON.stringify(OPENAPI), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const match = pathname.match(WEBHOOK_PATH_PATTERN);
    if (!match) {
      return notFound();
    }
    const [, provider, connectorId] = match as unknown as [string, WebhookEventProvider, string];
    // Defense in depth: the path pattern already enforces the slug shape, but
    // the shared CONNECTOR_ID_PATTERN stays the single authority.
    if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
      return notFound();
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    return handleWebhook(request, env, provider, connectorId);
  },
};
