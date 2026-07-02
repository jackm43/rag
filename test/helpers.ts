import nacl from "tweetnacl";

const encoder = new TextEncoder();

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
