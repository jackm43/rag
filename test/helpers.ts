import nacl from "tweetnacl";

import { encodeAiJobEnvelope } from "@rag/bot/contracts";
import { encodeManifestSnapshot, encodeServiceMessage, type EnvelopeOptions } from "@rag/contracts-core";
import type { AiJob } from "@rag/bot/contracts";
import type { Env } from "@rag/bot/contracts";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import {
  SERVICE_ZONE,
  SYSTEM_SUBJECT,
  type MachinePrincipal,
} from "@rag/service-kit/principal";
import { ensureRequestPlacement, serviceHopIntent } from "@rag/service-kit/control-plane";
import { serviceEnvelopeBytes } from "@rag/service-kit/message";
import {
  buildIdentityContext,
  importSigningKey,
  mint,
} from "@rag/service-kit/identity";
import { handleEgressRequest } from "@rag/egress/server";
import { runDeferredCommandByName, runInteractionSession } from "@rag/bot/lib/domain/commands/session-run";
import type { DiscordInteraction } from "@rag/bot/contracts";

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
  workflows: {
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
  registry: {
    kty: "OKP",
    crv: "Ed25519",
    x: "zwCQ4h35aDsQDr2aofod8QhE4u4uww4KaCZ0GEcZcYU",
    d: "CuSGcaxzaV7vi2ne2KLd7-bBZL5QwG_S2HX7In_RR0k",
  },
  attest: {
    kty: "OKP",
    crv: "Ed25519",
    x: "QbSbr-8d158rIxcFofS4AvtgO3A76D7E9FwRy1ak4ls",
    d: "3_7SfQiUyql_PSltf5dpOUCKqJyUIB7sJLl_fTOlyhQ",
  },
  metadata: {
    kty: "OKP",
    crv: "Ed25519",
    x: "QoTuiYTuWxzFJEBrMNz6v-FeEvolJn8LRkzApyo_Hkc",
    d: "rJZPpJDKLLdoj4UPIsCTAfHY4kusSL1npboKh4GNymw",
  },
  "dev-proxy": {
    kty: "OKP",
    crv: "Ed25519",
    x: "v60E6h2mWbtpW9KMMQdUhSOXVWjrJEzK6WDz1aaIfWU",
    d: "-JfMRkDnjb6MUpOzQGNYPWFCeQoGFOfgzT-mPsVmav4",
  },
  // The credential broker never signs in production (verify-only receiver); this
  // private half exists only so the test suite can mint a broker-issued token
  // when exercising the keyring exhaustively.
  connectors: {
    kty: "OKP",
    crv: "Ed25519",
    x: "tlvX0YnwjSma94r5lPNsnwn6FwXTxJy8x6R2ph55mho",
    d: "2TruP-IMZ-FIxM-KN94LNWNtITPBAHVTKwPPZpL2FEo",
  },
  webhooks: {
    kty: "OKP",
    crv: "Ed25519",
    x: "hYMdAmVmhbs_L4wEZVJRUtp8stUdIPCliYyjA2zdbUY",
    d: "NHQW5FI6wxkbQiVsVh7ub8Ex_DX-NxAktpaWjfU5BFE",
  },
  egress: {
    kty: "OKP",
    crv: "Ed25519",
    x: "OnAOWD6mg9DgW-k3_TzvUYJ6VzoVMEHcebPTYiUb8Tk",
    d: "7GkFG9GME0CNsZ1pb5nMf5CxVb2UUQR_A6PiVw7mHY8",
  },
};

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
export const mintServiceToken = async (
  envelope: Uint8Array,
  hop: ServiceHopSpec,
): Promise<string> => {
  const key = await importSigningKey(SIGNING_KEY_JWKS[hop.iss]);
  const sub = hop.sub ?? SYSTEM_SUBJECT;
  const placement = hop.env
    ? await ensureRequestPlacement({
        env: hop.env,
        subject: { sub },
        source: hop.iss,
        target: hop.aud,
        intent: serviceHopIntent(hop.aud, envelope),
      })
    : {};
  const context = await buildIdentityContext({
    iss: hop.iss,
    aud: hop.aud,
    sub,
    act: hop.act,
    trustZone: SERVICE_ZONE[hop.iss],
    envelopeBytes: envelope,
    requestId: placement.requestId,
    placementId: placement.placementId,
    correlationId: placement.correlationId,
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

// Encode an AI job and wrap it as a gateway->workflows service message, the shape
// the workflows worker consumer receives in production. Pass `env` (the same
// env the queue consumer under test will receive) when that env has a
// SERVICE_REGISTRY control-plane binding, so the minted token carries a real
// placement instead of being denied by the receiving server's placement
// enforcement.
export const gatewayAiJob = (job: AiJob, options: EnvelopeOptions, env?: Env): Promise<ServiceMessageBytes> =>
  signedServiceMessage(encodeAiJobEnvelope(job, options), {
    iss: "gateway",
    aud: "workflows",
    sub: subjectOf(job),
    env,
  });

// Extract the envelope bytes from a captured service message (what a producer
// handed the queue), for decoding in assertions.
export const sentEnvelope = (sent: unknown): Uint8Array => {
  const envelope = serviceEnvelopeBytes(sent);
  if (!envelope) {
    throw new Error("Captured queue body does not contain envelope bytes");
  }
  return envelope;
};

export const serviceRegistrySnapshot = () =>
  encodeManifestSnapshot([
    {
      service: "gateway",
      zone: "platform",
      targets: ["workflows"],
      operations: ["devproxy.command"],
      scopes: ["gateway:control:control-plane", "gateway:devproxy:management"],
    },
    {
      service: "workflows",
      zone: "application",
      targets: ["responder", "spend", "connectors"],
      operations: [
        "thread_start",
        "thread_reply",
        "channel_reply",
        "ask",
        "ragjam",
        "bicture",
        "message.received",
        "webhook.event",
      ],
      scopes: [],
    },
    {
      service: "responder",
      zone: "application",
      targets: [],
      operations: ["reply.channel_message", "reply.interaction_edit"],
      scopes: [],
    },
    {
      service: "spend",
      zone: "application",
      targets: [],
      operations: ["spend"],
      scopes: [],
    },
    {
      service: "registry",
      zone: "control-plane",
      targets: ["registry", "connectors"],
      operations: ["registry.invoke"],
      scopes: [],
    },
    {
      service: "metadata",
      zone: "application",
      targets: ["metadata", "registry", "attest"],
      operations: ["metadata.query"],
      scopes: [],
    },
    {
      service: "attest",
      zone: "platform",
      targets: ["attest", "connectors"],
      operations: ["attest.invoke"],
      scopes: [],
    },
    {
      service: "dev-proxy",
      zone: "platform",
      targets: ["gateway", "connectors"],
      operations: [],
      scopes: [],
    },
    {
      service: "connectors",
      zone: "application",
      targets: [],
      operations: ["connector.invoke"],
      scopes: [],
    },
    {
      service: "webhooks",
      zone: "platform",
      targets: ["connectors", "workflows"],
      operations: [],
      scopes: [],
    },
    {
      service: "egress",
      zone: "platform",
      targets: [],
      operations: ["egress.request"],
      scopes: [],
    },
  ]);

// A minimal but fully functional in-memory control plane: it implements the
// same createIntent/createPlacement/consumePlacement RPCs the real
// SERVICE_REGISTRY Durable Object exposes (packages/service-kit/control-plane.ts),
// so tests that build an env with this mock exercise the real placement
// enforcement path end to end (mint on the client side, consume on the
// server side) rather than tripping the "misconfigured registry" fail-closed
// path. It intentionally skips the TTL/versioning edge cases the dedicated
// control-plane tests (test/packages/service-kit/client.test.ts) cover directly —
// every intent/placement created here is valid until the test process ends.
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

export const createServiceRegistryMock = () => {
  const stub = createControlPlaneStub();
  return {
    idFromName: (name: string) => name,
    get: () => stub,
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
    // Signing keys for the workers that mint peer tokens (gateway, workflows).
    GATEWAY_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.gateway),
    WORKFLOWS_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.workflows),
    RESPONDER_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.responder),
    CONNECTORS_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.connectors),
    // The spend worker signs its own egress hops (cloudflare-api profile).
    SPEND_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.spend),
    METADATA_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.metadata),
    ATTEST_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.attest),
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
    SERVICE_REGISTRY: createServiceRegistryMock(),
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
