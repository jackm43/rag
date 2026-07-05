import nacl from "tweetnacl";

import { encodeAiJobEnvelope } from "@rag/discord/contracts";
import type { EnvelopeOptions } from "@rag/contracts-core";
import type { AiJob } from "@rag/discord/contracts";
import type { Env } from "@rag/discord/contracts";
import { runInteractionSession } from "@rag/discord/commands/session-run";
import { processMessageReceivedJob } from "@rag/discord/domain/consumer";
import type { DiscordInteraction, MessageReceivedJob } from "@rag/discord/contracts";

const encoder = new TextEncoder();

// Encode an AI job as the plain capnp envelope the workflows worker consumer
// receives in production (producers hand the queue the raw envelope bytes — no
// signed wrapper). `_env` is retained for call-site compatibility and ignored.
export const gatewayAiJob = async (job: AiJob, options: EnvelopeOptions, _env?: Env): Promise<Uint8Array> =>
  encodeAiJobEnvelope(job, options);

// A producer now hands the queue the raw capnp envelope bytes directly (no
// signed ServiceMessage wrapper), so the captured body IS the envelope.
export const sentEnvelope = (sent: unknown): Uint8Array => sent as Uint8Array;

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
  // Outbound HTTP is in-process now (createEgressClient builds a boundary client
  // that fetches directly), so there is no EGRESS binding to stub — the boundary
  // client injects credentials from this env's own vars (DISCORD_BOT_TOKEN,
  // CF_AIG_TOKEN, CLOUDFLARE_API_TOKEN) and hits the suite's global-fetch mocks.
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
