import nacl from "tweetnacl";

import { encodeAiJobEnvelope } from "@rag/discord/contracts";
import type { EnvelopeOptions } from "@rag/contracts-core";
import type { AiJob } from "@rag/discord/contracts";
import type { Env } from "@rag/discord/contracts";
import {
  SERVICE_ZONE,
  SYSTEM_SUBJECT,
  type MachinePrincipal,
} from "@rag/service-kit/principal";
import { handleEgressRequest } from "@rag/egress/server";
import { runDeferredCommandByName, runInteractionSession } from "@rag/discord/lib/domain/commands/session-run";
import { processMessageReceivedJob } from "@rag/discord/lib/domain/consumer";
import type { DiscordInteraction, MessageReceivedJob } from "@rag/discord/contracts";

const encoder = new TextEncoder();

// Test signing keys: the private halves of the committed PUBLIC_KEYRING, so a
// token minted here verifies against the real keyring in the workers under
// test. In production these live in per-worker secrets, never the repo — these
// are test fixtures only. (No `alg` field: workerd's importKey rejects
// alg:"Ed25519" on an OKP JWK.)
export type ServiceHopSpec = {
  iss: MachinePrincipal;
  aud: MachinePrincipal;
  sub?: string;
  act?: MachinePrincipal[];
  // Optional: when a test's receiving env has a SERVICE_REGISTRY binding
  // (a working control plane, e.g. via createServiceRegistryMock), pass it
  // here so the minted token carries a real requestId/placementId exactly
  // like the production client (ensureRequestPlacement) would. Tests that
  // exercise a receiving env with a control plane but mint through this
  // helper without an env would otherwise always fail placement
  // consumption — not because anything is misconfigured, but because the
  // token itself never carried placement fields. Omit env (the default) for
  // tests that intentionally exercise the no-control-plane (case a) path.
  env?: Env;
};

// Mint a service identity-context token bound to the given envelope bytes.
// When `hop.env` is supplied, this mirrors the production client path
// (packages/service-kit/client.ts mintToken): it first calls ensureRequestPlacement
// against the same control plane the receiving server will consume against,
// so placement enforcement is exercised end to end instead of bypassed.
const subjectOf = (job: AiJob): string => {
  const candidate = job as { requesterUserId?: string; authorId?: string };
  return candidate.requesterUserId ?? candidate.authorId ?? SYSTEM_SUBJECT;
};

// Encode an AI job and wrap it as a gateway->workflows service message, the shape
// the workflows worker consumer receives in production. Pass `env` (the same
// env the queue consumer under test will receive) when that env has a
// SERVICE_REGISTRY control-plane binding, so the minted token carries a real
// placement instead of being denied by the receiving server's placement
// enforcement.
export const gatewayAiJob = async (job: AiJob, options: EnvelopeOptions, _env?: Env): Promise<Uint8Array> =>
  encodeAiJobEnvelope(job, options);

// A producer now hands the queue the raw capnp envelope bytes directly (no
// signed ServiceMessage wrapper), so the captured body IS the envelope.
export const sentEnvelope = (sent: unknown): Uint8Array => sent as Uint8Array;

type MockIntent = {
  id: string;
  correlationId: string;
  subject: string;
  target: string;
  revoked: boolean;
};

type MockPlacement = {
  id: string;
  requestId: string;
  correlationId: string;
  subject: string;
  source: string;
  target: string;
  action: string;
  resource: string;
  method: string;
  consumed: boolean;
};

const createControlPlaneStub = () => {
  const intents = new Map<string, MockIntent>();
  const placements = new Map<string, MockPlacement>();
  let intentSeq = 0;
  let placementSeq = 0;

  return {
    register: async () => undefined,
    snapshot: async () => serviceRegistrySnapshot(),
    createIntent: async (record: {
      correlationId: string;
      subject: string;
      target?: string;
      aud: string;
    }) => {
      const id = `request-${++intentSeq}`;
      intents.set(id, {
        id,
        correlationId: record.correlationId,
        subject: record.subject,
        target: record.aud,
        revoked: false,
      });
      return {
        id,
        correlationId: record.correlationId,
        expiresAt: Date.now() + 5 * 60_000,
        version: 1,
      };
    },
    createPlacement: async (record: {
      requestId: string;
      correlationId: string;
      subject: string;
      source: string;
      target: string;
      action: string;
      resource: string;
      method: string;
    }) => {
      const intent = intents.get(record.requestId);
      if (!intent || intent.revoked) {
        return null;
      }
      const id = `placement-${++placementSeq}`;
      placements.set(id, {
        id,
        requestId: record.requestId,
        correlationId: record.correlationId,
        subject: record.subject,
        source: record.source,
        target: record.target,
        action: record.action,
        resource: record.resource,
        method: record.method,
        consumed: false,
      });
      return {
        id,
        correlationId: record.correlationId,
        expiresAt: Date.now() + 90_000,
        intentVersion: 1,
      };
    },
    consumePlacement: async (input: {
      placementId: string;
      requestId: string;
      correlationId?: string;
      subject: string;
      source: string;
      target: string;
      action: string;
      resource: string;
      method: string;
    }) => {
      const placement = placements.get(input.placementId);
      if (!placement || placement.consumed) {
        return false;
      }
      placement.consumed = true;
      const intent = intents.get(input.requestId);
      return (
        !!intent &&
        !intent.revoked &&
        placement.requestId === input.requestId &&
        (input.correlationId === undefined || placement.correlationId === input.correlationId) &&
        placement.subject === input.subject &&
        placement.source === input.source &&
        placement.target === input.target &&
        placement.action === input.action &&
        placement.resource === input.resource &&
        placement.method === input.method
      );
    },
    revokeIntent: async (requestId: string) => {
      const intent = intents.get(requestId);
      if (!intent) {
        return null;
      }
      intent.revoked = true;
      return { id: requestId, revokedAt: Date.now(), version: 2 };
    },
    bumpIntentVersion: async (requestId: string) => {
      const intent = intents.get(requestId);
      if (!intent) {
        return null;
      }
      return { id: requestId, version: 2 };
    },
  };
};

export const createSignedRequest = (
  payload: unknown,
  secretKey: Uint8Array,
  path = "/discord",
  timestamp = String(Math.floor(Date.now() / 1000)),
) => {
  const rawBody = JSON.stringify(payload);
  const message = encoder.encode(timestamp + rawBody);
  const signature = nacl.sign.detached(message, secretKey);
  const signatureHex = Buffer.from(signature).toString("hex");

  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signatureHex,
      "x-signature-timestamp": timestamp,
    },
    body: rawBody,
  });
};

export const createEnv = (publicKeyHex: string, overrides: Record<string, unknown> = {}) => {
  const env: Record<string, unknown> = {
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_APPLICATION_ID: "application-id",
    DISCORD_BOT_TOKEN: "bot-token",
    // Outbound credentials the in-process EGRESS stub (below) injects from the
    // bundled default profiles. In production these live only on the egress
    // worker; here they let the real egress path run under the suite's global
    // fetch mocks and produce byte-identical injected headers.
    CF_AIG_TOKEN: "gateway-token",
    CLOUDFLARE_API_TOKEN: "cf-token",
    DB: {
      prepare: () => {
        throw new Error("DB should not be used in this test");
      },
      batch: () => {
        throw new Error("DB should not be used in this test");
      },
    },
    AI: {
      run: () => {
        throw new Error("AI should not be used in this test");
      },
    },
    AI_JOBS: {
      send: () => {
        throw new Error("AI_JOBS should not be used in this test");
      },
    },
    DISCORD_OUTBOX: {
      send: () => {
        throw new Error("DISCORD_OUTBOX should not be used in this test");
      },
    },
    RESPONDER: {
      deliverInteractionEdit: () => {
        throw new Error("RESPONDER should not be used in this test");
      },
    },
    ...overrides,
  };
  // Realistic in-process EGRESS binding: fetchProfile runs the REAL egress
  // server (packages/egress/server.ts) against this SAME env object. There is
  // no EGRESS_CONTROL binding, so the server falls back to the bundled default
  // profiles (packages/egress/profiles.ts); credentials come from this env's
  // own vars (DISCORD_BOT_TOKEN, CF_AIG_TOKEN, CLOUDFLARE_API_TOKEN). This
  // makes every application outbound HTTP path run the true egress hop under
  // the suite's global-fetch mocks. Overridable via `overrides.EGRESS`.
  if (env.EGRESS === undefined) {
    env.EGRESS = {
      fetchProfile: (message: unknown, body?: ArrayBuffer) =>
        handleEgressRequest(env as never, message, body),
    };
  }
  // In-process INTERACTION_SESSION stub: production kicks the workflows worker's
  // Durable Object (idFromName(interactionToken)) to run a deferred command and
  // edit the response as `workflows`. Here we run the SAME dispatch synchronously
  // against this env, so a deferred command's edit still travels the real egress
  // hop under the suite's global-fetch mocks. Overridable via overrides.
  if (env.INTERACTION_SESSION === undefined) {
    env.INTERACTION_SESSION = {
      idFromName: (name: string) => name,
      get: () => ({
        run: (interaction: DiscordInteraction) =>
          runInteractionSession(interaction, env as never),
        runMention: (job: MessageReceivedJob) =>
          processMessageReceivedJob(job, env as never, Date.now()),
        runDeferredCommand: (interaction: DiscordInteraction, commandName: string) =>
          runDeferredCommandByName(interaction, commandName, env as never),
      }),
    };
  }
  return env as never;
};

// DB mock that supports prepare().run(), prepare().bind().run(), and first().
export const createDbMock = (options: {
  ragCount?: number;
  ragBan?: { expires_at: string } | null;
  latestRagEventId?: number | null;
  reportCount?: number;
  aiThread?: {
    thread_id: string;
    parent_channel_id?: string | null;
    source_message_id?: string | null;
    requester_user_id?: string | null;
    requester_username?: string | null;
    initial_prompt: string;
    title: string;
  } | null;
  onBatch?: (statements: Array<{ sql: string; args: unknown[] }>) => void;
} = {}) => ({
  batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
    options.onBatch?.(statements);
    return statements.map((statement) =>
      statement.sql.includes("RETURNING rag_count")
        ? { results: [{ rag_count: options.ragCount ?? 1 }] }
        : { results: [] },
    );
  },
  prepare: (sql: string) => {
    const runner = (args: unknown[]) => ({
      sql,
      args,
      run: async () => {
        return { results: undefined };
      },
      first: async () => {
        if (sql.includes("FROM rag_command_bans")) {
          return options.ragBan ?? null;
        }
        if (sql.includes("FROM rag_events")) {
          return options.latestRagEventId === undefined || options.latestRagEventId === null
            ? null
            : { id: options.latestRagEventId };
        }
        if (sql.includes("SELECT rag_count")) {
          return { rag_count: options.ragCount ?? 1 };
        }
        if (sql.includes("SELECT COUNT")) {
          return { report_count: options.reportCount ?? 1 };
        }
        if (sql.includes("FROM rag_ai_threads")) {
          return options.aiThread ?? null;
        }
        return null;
      },
      all: async () => ({ results: [], meta: {} }),
    });
    return {
      ...runner([]),
      bind: (...args: unknown[]) => runner(args),
    };
  },
});
