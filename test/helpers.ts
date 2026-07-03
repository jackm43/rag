import nacl from "tweetnacl";

import {
  decodeServiceMessage,
  encodeAiJobEnvelope,
  encodeServiceMessage,
  type EnvelopeOptions,
} from "../packages/contracts";
import type { AiJob, ServiceMessageBytes } from "../packages/contracts/types";
import {
  SERVICE_ZONE,
  SYSTEM_SUBJECT,
  type MachinePrincipal,
} from "../packages/auth/principal";
import {
  buildIdentityContext,
  importSigningKey,
  mint,
} from "../packages/identity";

const encoder = new TextEncoder();

// Test signing keys: the private halves of the committed PUBLIC_KEYRING, so a
// token minted here verifies against the real keyring in the workers under
// test. In production these live in per-worker secrets, never the repo — these
// are test fixtures only. (No `alg` field: workerd's importKey rejects
// alg:"Ed25519" on an OKP JWK.)
export const SIGNING_KEY_JWKS: Record<MachinePrincipal, JsonWebKey> = {
  gateway: {
    kty: "OKP",
    crv: "Ed25519",
    x: "WLBRy5_x-U27lYp3QoCm3dg4NzmMAIBT8w6oODf7-Og",
    d: "N_RqZdAxNC7iLFzXtxMtTxzTQ7PE0djTuhz7lCKRM8U",
  },
  brain: {
    kty: "OKP",
    crv: "Ed25519",
    x: "CpovGn_wbuSw6KN94Cisarey69JrMAvJx55YtCpSBpE",
    d: "bowGn2P5AkhzZ3-ZqSi6d3KPLiHqFvvZlj2znaosbs0",
  },
  responder: {
    kty: "OKP",
    crv: "Ed25519",
    x: "Lnp9NNeP_35T7f1Mw0hTpJmnuMfnppbfkt3ToVwroGc",
    d: "cGVoMwC1JCWrkBfIr3dM_NxN8lGEmvpQA7_gbQ34p1A",
  },
  spend: {
    kty: "OKP",
    crv: "Ed25519",
    x: "RHa6T_vqdx5v_bttgMzenwtdLII_Ud6_aP5CB6h7BSk",
    d: "uJn1_O-H6bTLEUvYzqSHupb9veb9BM_36Z_pKLjNXyY",
  },
};

export type ServiceHopSpec = {
  iss: MachinePrincipal;
  aud: MachinePrincipal;
  sub?: string;
  act?: MachinePrincipal[];
};

// Mint a service identity-context token bound to the given envelope bytes.
export const mintServiceToken = async (
  envelope: Uint8Array,
  hop: ServiceHopSpec,
): Promise<string> => {
  const key = await importSigningKey(SIGNING_KEY_JWKS[hop.iss]);
  const context = await buildIdentityContext({
    iss: hop.iss,
    aud: hop.aud,
    sub: hop.sub ?? SYSTEM_SUBJECT,
    act: hop.act,
    trustZone: SERVICE_ZONE[hop.iss],
    envelopeBytes: envelope,
  });
  return mint(key, context);
};

// Wrap an envelope as the capnp ServiceMessage bytes that consumers expect.
export const signedServiceMessage = async (
  envelope: Uint8Array,
  hop: ServiceHopSpec,
): Promise<ServiceMessageBytes> =>
  encodeServiceMessage(envelope, await mintServiceToken(envelope, hop));

const subjectOf = (job: AiJob): string => {
  const candidate = job as { requesterUserId?: string; authorId?: string };
  return candidate.requesterUserId ?? candidate.authorId ?? SYSTEM_SUBJECT;
};

// Encode an AI job and wrap it as a gateway->brain service message, the shape
// the brain consumer receives in production.
export const gatewayAiJob = (job: AiJob, options: EnvelopeOptions): Promise<ServiceMessageBytes> =>
  signedServiceMessage(encodeAiJobEnvelope(job, options), {
    iss: "gateway",
    aud: "brain",
    sub: subjectOf(job),
  });

// Extract the envelope bytes from a captured service message (what a producer
// handed the queue), for decoding in assertions.
export const sentEnvelope = (sent: unknown): Uint8Array => {
  const wire = decodeServiceMessage(sent);
  if (!wire) {
    throw new Error("Captured queue body is not a capnp ServiceMessage");
  }
  return wire.envelope;
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

export const createEnv = (publicKeyHex: string, overrides: Record<string, unknown> = {}) =>
  ({
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_APPLICATION_ID: "application-id",
    DISCORD_BOT_TOKEN: "bot-token",
    // Signing keys for the workers that mint peer tokens (gateway, brain).
    GATEWAY_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.gateway),
    BRAIN_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.brain),
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
  }) as never;

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
