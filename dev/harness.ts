// Simulates Discord traffic against the real bot code, in-process.
//
// simulateMention feeds a synthetic gateway MESSAGE_CREATE through
// handleMessageCreate (src/events/messageCreate.ts) exactly as the DiscordGateway
// Durable Object would; simulateInteraction feeds a synthetic slash-command
// interaction through dispatch (src/structs/registry.ts) exactly as
// POST /interactions would after signature verification. Discord REST is
// answered by local stubs (nothing reaches the guild); the AI Gateway is called
// for real and the exchange is captured for the UI.
import askWebSearchConfig from "../src/lib/ai/ai-config/ask-web-search.json";
import responseConfig from "../src/lib/ai/ai-config/discord-response.json";
import { loadConfig, resetConfigCache, type BotConfig } from "../src/lib/ai/config";
import { inferenceClient } from "../src/lib/ai/inference";
import { isRecord, type DiscordMessage } from "../src/lib/contracts";
import { recordAiThread } from "../src/lib/db/threads";
import type { Env } from "../src/env";
import { handleMessageCreate } from "../src/events/messageCreate";
import { dispatch } from "../src/structs/registry";
import {
  redactHeaders,
  runWithFetchTap,
  type CapturedCall,
  type CapturedLog,
  type TapHandler,
} from "./fetch-tap";

// --- inputs ---

export type DevIdentity = {
  userId: string;
  // Discord account name (unique handle).
  username: string;
  // Profile display name.
  globalName?: string | null;
  // Per-guild nickname (what the bot prefers as the display name).
  nick?: string | null;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "bot";
  content: string;
  author?: DevIdentity;
};

export type ConfigOverrides = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  historyLimit?: number;
  webSearchModel?: string;
  // Raw KV texts (keyed by AI_CONFIG key) to serve instead of the bundled
  // files — a snapshot of the production namespace, typically.
  kv?: Record<string, string>;
};

export type MentionMode = "channel" | "thread" | "ask_thread";

export type MentionSimulationInput = {
  content: string;
  mentionBot: boolean;
  identity: DevIdentity;
  botUserId: string;
  guildId: string;
  channelId: string;
  mode: MentionMode;
  // Prior messages in this channel/thread, oldest first.
  transcript: TranscriptEntry[];
  replyToId?: string;
  overrides?: ConfigOverrides;
};

export type InteractionOption = { name: string; type: number; value: string };

export type InteractionSimulationInput = {
  command: string;
  options: InteractionOption[];
  // Users referenced by USER options, as Discord would resolve them.
  resolvedUsers?: Record<string, DevIdentity>;
  identity: DevIdentity;
  guildId: string;
  channelId: string;
  overrides?: ConfigOverrides;
};

// --- outputs ---

export type AiExchange = {
  transport: "gateway-http" | "workers-ai-binding";
  model: string;
  request: unknown;
  response: unknown;
  error?: string;
  durationMs: number;
};

export type CapturedAttachment = {
  name: string;
  contentType: string;
  bytes: number;
  dataUrl?: string;
};

export type CapturedDiscordMessage = {
  // The id the stub assigned to a posted channel message.
  id?: string;
  channelId: string;
  content: string;
  allowedMentions?: unknown;
  attachments: CapturedAttachment[];
};

export type SimulationBase = {
  durationMs: number;
  ai: AiExchange[];
  calls: CapturedCall[];
  logs: CapturedLog[];
  db: {
    interaction: Record<string, unknown> | null;
    spendEvents: Record<string, unknown>[];
  };
};

export type MentionSimulationResult = SimulationBase & {
  message: DiscordMessage;
  // Messages the bot posted into the channel (the first is its reply).
  replies: CapturedDiscordMessage[];
};

export type InteractionSimulationResult = SimulationBase & {
  interaction: Record<string, unknown>;
  edits: CapturedDiscordMessage[];
  followUps: CapturedDiscordMessage[];
  channelMessages: CapturedDiscordMessage[];
  threadsCreated: Array<{ id: string; name: string; parentId: string }>;
};

export type SimulationOptions = {
  // What unhandled (non-Discord) calls fall through to. Tests stub the gateway.
  upstream?: typeof fetch;
};

// --- helpers ---

const DISCORD_EPOCH = 1420070400000n;
const BOT_USERNAME = "ragbot";
const MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export const snowflake = () =>
  (((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | BigInt(Math.floor(Math.random() * 4096))).toString();

export const displayName = (identity: DevIdentity) =>
  identity.nick?.trim() || identity.globalName?.trim() || identity.username.trim() || "user";

const json = (body: unknown, status = 200) => Response.json(body, { status });

const authorFor = (identity: DevIdentity) => ({
  id: identity.userId,
  username: identity.username,
  global_name: identity.globalName ?? null,
});

const transcriptToDiscordMessage = (
  entry: TranscriptEntry,
  input: Pick<MentionSimulationInput, "identity" | "botUserId" | "guildId" | "channelId">,
): DiscordMessage =>
  entry.role === "bot"
    ? {
      id: entry.id,
      channel_id: input.channelId,
      guild_id: input.guildId,
      content: entry.content,
      author: { id: input.botUserId, username: BOT_USERNAME, bot: true },
    }
    : {
      id: entry.id,
      channel_id: input.channelId,
      guild_id: input.guildId,
      content: entry.content,
      author: authorFor(entry.author ?? input.identity),
      member: { nick: (entry.author ?? input.identity).nick ?? null },
    };

// The gateway MESSAGE_CREATE payload for what the user typed, shaped like
// Discord sends it (mention token in content + the mentions array, reply
// reference + inlined referenced_message).
export const buildMentionMessage = (input: MentionSimulationInput): DiscordMessage => {
  const content = input.mentionBot ? `<@${input.botUserId}> ${input.content}`.trim() : input.content;
  const replyTo = input.replyToId
    ? input.transcript.find((entry) => entry.id === input.replyToId)
    : undefined;
  return {
    id: snowflake(),
    guild_id: input.guildId,
    channel_id: input.channelId,
    content,
    author: authorFor(input.identity),
    member: { nick: input.identity.nick ?? null },
    mentions: input.mentionBot ? [{ id: input.botUserId, username: BOT_USERNAME }] : [],
    mention_roles: [],
    attachments: [],
    ...(replyTo
      ? {
        message_reference: { channel_id: input.channelId, message_id: replyTo.id },
        referenced_message: transcriptToDiscordMessage(replyTo, input),
      }
      : {}),
  };
};

const withOverrides = (base: Record<string, unknown>, patch: Record<string, unknown | undefined>) => {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null && value !== "") {
      out[key] = value;
    }
  }
  return out;
};

const parseKvJson = (text: string | undefined, fallback: Record<string, unknown>) => {
  if (!text) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

// A KVNamespace stand-in for AI_CONFIG that serves the bundled config (or the
// supplied production snapshot) with the run's overrides applied. loadConfig
// reads KV first, so this is how one run gets its own model/temperature without
// touching the bundled files or the real namespace.
const configNamespace = (overrides: ConfigOverrides): KVNamespace => {
  const kv = overrides.kv ?? {};
  const values: Record<string, string> = { ...kv };
  values["discord-response.json"] = JSON.stringify(
    withOverrides(parseKvJson(kv["discord-response.json"], responseConfig), {
      model: overrides.model,
      temperature: overrides.temperature,
      maxTokens: overrides.maxTokens,
      historyLimit: overrides.historyLimit,
    }),
  );
  values["ask-web-search.json"] = JSON.stringify(
    withOverrides(parseKvJson(kv["ask-web-search.json"], askWebSearchConfig), {
      model: overrides.webSearchModel,
    }),
  );
  return {
    get: async (key: string) => values[key] ?? null,
  } as unknown as KVNamespace;
};

// Records Workers AI binding calls (the path the gateway-HTTP tap cannot see).
const wrapAiBinding = (ai: Ai | undefined, exchanges: AiExchange[]): Ai | undefined => {
  if (!ai) {
    return ai;
  }
  return new Proxy(ai, {
    get(target, prop) {
      if (prop !== "run") {
        return Reflect.get(target, prop);
      }
      return async (model: string, input: unknown, rawOptions?: unknown) => {
        const startedAt = Date.now();
        // Tag binding calls routed through the gateway the same way the HTTP
        // tap tags them, so gateway logs separate dev traffic from production.
        const options = isRecord(rawOptions) && isRecord(rawOptions.gateway)
          ? {
            ...rawOptions,
            gateway: {
              ...rawOptions.gateway,
              metadata: tagDevMetadata(isRecord(rawOptions.gateway.metadata) ? rawOptions.gateway.metadata : {}),
            },
          }
          : rawOptions;
        const exchange: AiExchange = {
          transport: "workers-ai-binding",
          model,
          request: { binding: "AI", model, input, options },
          response: undefined,
          durationMs: 0,
        };
        exchanges.push(exchange);
        try {
          const result = await (target.run as (...args: unknown[]) => Promise<unknown>)(model, input, options);
          exchange.response = summarizeBindingResult(result);
          return result;
        } catch (error) {
          exchange.error = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          exchange.durationMs = Date.now() - startedAt;
        }
      };
    },
  });
};

const summarizeBindingResult = (result: unknown): unknown => {
  if (result instanceof ReadableStream) {
    return { stream: true };
  }
  if (result instanceof ArrayBuffer || result instanceof Uint8Array) {
    return { binary: true, bytes: result.byteLength };
  }
  return result;
};

// AI Gateway keeps at most five custom metadata keys per request. The bot's
// own attribution already uses five on a mention (kind, request id, user,
// channel, message), so the dev tag goes first and the least useful synthetic
// ids are dropped to stay within the cap.
const AIG_METADATA_MAX_KEYS = 5;
const DEV_METADATA_DROP_ORDER = ["discord_message_id", "discord_channel_id"];

const tagDevMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const tagged: Record<string, unknown> = { ragbot_env: "dev", ...metadata };
  for (const key of DEV_METADATA_DROP_ORDER) {
    if (Object.keys(tagged).length <= AIG_METADATA_MAX_KEYS) {
      break;
    }
    delete tagged[key];
  }
  return tagged;
};

const withDevMetadata = (request: Request) => {
  const headers = new Headers(request.headers);
  const existing = headers.get("cf-aig-metadata");
  let metadata: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      metadata = isRecord(parsed) ? parsed : {};
    } catch {
      metadata = {};
    }
  }
  headers.set("cf-aig-metadata", JSON.stringify(tagDevMetadata(metadata)));
  return new Request(request, { headers });
};

const bytesToDataUrl = (bytes: ArrayBuffer, contentType: string) => {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index]);
  }
  return `data:${contentType};base64,${btoa(binary)}`;
};

// The subset of Request the write reader needs; keeps it agnostic of the Cf
// generics workers-types attaches to cloned requests.
type RequestBody = { headers: Headers; formData(): Promise<FormData>; text(): Promise<string> };

// Reads a Discord message write (JSON or multipart with files) into the
// captured shape, inlining small media so the UI can preview it.
const readDiscordMessageWrite = async (request: RequestBody, channelId: string): Promise<CapturedDiscordMessage> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const payload = form.get("payload_json");
    const data = typeof payload === "string" ? parseKvJson(payload, {}) : {};
    const files: File[] = [];
    form.forEach((value) => {
      if (typeof value !== "string") {
        files.push(value);
      }
    });
    const attachments: CapturedAttachment[] = [];
    for (const value of files) {
      const attachment: CapturedAttachment = { name: value.name, contentType: value.type, bytes: value.size };
      if (value.size <= MAX_INLINE_ATTACHMENT_BYTES) {
        attachment.dataUrl = bytesToDataUrl(await value.arrayBuffer(), value.type || "application/octet-stream");
      }
      attachments.push(attachment);
    }
    return {
      channelId,
      content: typeof data.content === "string" ? data.content : "",
      allowedMentions: data.allowed_mentions,
      attachments,
    };
  }
  const data = parseKvJson(await request.text(), {});
  return {
    channelId,
    content: typeof data.content === "string" ? data.content : "",
    allowedMentions: data.allowed_mentions,
    attachments: [],
  };
};

const DISCORD_API_PREFIX = "/api/v10";

type DiscordStubState = {
  channelId: string;
  guildId: string;
  isThread: boolean;
  history: DiscordMessage[];
  resolvedUsers: Record<string, DevIdentity>;
  channelMessages: CapturedDiscordMessage[];
  edits: CapturedDiscordMessage[];
  followUps: CapturedDiscordMessage[];
  threadsCreated: Array<{ id: string; name: string; parentId: string }>;
};

// Local stand-in for Discord REST. Everything the mention and slash-command
// flows call is answered here; anything else on discord.com gets an empty 200
// and is flagged in the capture. Non-Discord hosts fall through upstream.
const discordStub = (state: DiscordStubState): TapHandler => async (request, call) => {
  const url = new URL(request.url);
  if (url.hostname === "gateway.ai.cloudflare.com") {
    return withDevMetadata(request);
  }
  if (url.hostname !== "discord.com") {
    return undefined;
  }

  const path = url.pathname.startsWith(DISCORD_API_PREFIX)
    ? url.pathname.slice(DISCORD_API_PREFIX.length)
    : url.pathname;
  const method = request.method;
  const segments = path.split("/").filter(Boolean);

  // GET /guilds/{guild}/members/{user}
  if (method === "GET" && segments[0] === "guilds" && segments[2] === "members") {
    call.note = "bot member lookup (no roles)";
    return json({ user: { id: segments[3], username: BOT_USERNAME }, roles: [] });
  }

  // GET /channels/{channel}
  if (method === "GET" && segments[0] === "channels" && segments.length === 2) {
    call.note = state.isThread ? "thread channel" : "text channel";
    return json(
      state.isThread
        ? { id: segments[1], type: 11, parent_id: state.guildId, name: "dev-thread" }
        : { id: segments[1], type: 0, name: "dev-channel" },
    );
  }

  // GET /channels/{channel}/messages?before=&limit=
  if (method === "GET" && segments[0] === "channels" && segments[2] === "messages" && segments.length === 3) {
    const before = url.searchParams.get("before");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    // Newest first, as Discord returns them; `before` excludes the current
    // message, which is never part of the served history anyway.
    const page = [...state.history]
      .reverse()
      .filter((message) => !before || message.id !== before)
      .slice(0, Math.max(1, limit));
    call.note = `history: ${page.length} message(s) from the transcript`;
    return json(page);
  }

  // GET /channels/{channel}/messages/{message}
  if (method === "GET" && segments[0] === "channels" && segments[2] === "messages" && segments.length === 4) {
    const found = state.history.find((message) => message.id === segments[3]);
    call.note = found ? "referenced message from the transcript" : "referenced message not in transcript";
    return found ? json(found) : json({ message: "Unknown Message", code: 10008 }, 404);
  }

  // POST /channels/{channel}/messages
  if (method === "POST" && segments[0] === "channels" && segments[2] === "messages") {
    const captured = await readDiscordMessageWrite(request.clone(), segments[1]);
    const id = snowflake();
    state.channelMessages.push({ id, ...captured });
    call.note = "bot posted a channel message";
    return json({ id, channel_id: segments[1], content: captured.content });
  }

  // POST /channels/{channel}/threads and /channels/{channel}/messages/{id}/threads
  if (method === "POST" && segments[0] === "channels" && segments[segments.length - 1] === "threads") {
    const body = parseKvJson(await request.clone().text(), {});
    const thread = { id: snowflake(), name: typeof body.name === "string" ? body.name : "thread", parentId: segments[1] };
    state.threadsCreated.push(thread);
    call.note = "thread created";
    return json({ id: thread.id, type: 11, parent_id: thread.parentId, name: thread.name });
  }

  // GET /users/{user}
  if (method === "GET" && segments[0] === "users" && segments.length === 2) {
    const known = state.resolvedUsers[segments[1]];
    call.note = known ? "user lookup (resolved)" : "user lookup (synthetic)";
    return json({ id: segments[1], username: known?.username ?? `user_${segments[1].slice(-4)}` });
  }

  // PATCH /webhooks/{app}/{token}/messages/@original
  if (method === "PATCH" && segments[0] === "webhooks" && segments[segments.length - 1] === "@original") {
    state.edits.push(await readDiscordMessageWrite(request.clone(), state.channelId));
    call.note = "deferred reply edited";
    return json({ id: snowflake() });
  }

  // POST /webhooks/{app}/{token}
  if (method === "POST" && segments[0] === "webhooks") {
    state.followUps.push(await readDiscordMessageWrite(request.clone(), state.channelId));
    call.note = "follow-up posted";
    return json({ id: snowflake() });
  }

  call.note = "unstubbed Discord call (empty 200)";
  return json({});
};

// AI Gateway HTTP exchanges, lifted out of the raw capture list.
const gatewayExchanges = (calls: CapturedCall[]): AiExchange[] =>
  calls
    .filter((call) => call.url.includes("gateway.ai.cloudflare.com"))
    .map((call) => ({
      transport: "gateway-http" as const,
      model: isRecord(call.body) && typeof call.body.model === "string" ? call.body.model : "unknown",
      request: { method: call.method, url: call.url, headers: call.headers, body: call.body },
      response: call.response,
      ...(call.response && call.response.status >= 400 ? { error: `HTTP ${call.response.status}` } : {}),
      durationMs: call.durationMs,
    }));

const readDbSideEffects = async (
  env: Env,
  messageId: string | null,
  spendIdWatermark: number,
): Promise<SimulationBase["db"]> => {
  let interaction: Record<string, unknown> | null = null;
  let spendEvents: Record<string, unknown>[] = [];
  try {
    if (messageId) {
      interaction = await env.DB.prepare("SELECT * FROM rag_ai_interactions WHERE message_id = ? ORDER BY id DESC LIMIT 1")
        .bind(messageId)
        .first<Record<string, unknown>>();
    } else {
      interaction = await env.DB.prepare("SELECT * FROM rag_ai_interactions ORDER BY id DESC LIMIT 1")
        .first<Record<string, unknown>>();
    }
    const spend = await env.DB.prepare("SELECT * FROM rag_ai_spend_events WHERE id > ? ORDER BY id ASC")
      .bind(spendIdWatermark)
      .all<Record<string, unknown>>();
    spendEvents = spend.results ?? [];
  } catch {
    // Side-effect inspection is best-effort; the run itself already happened.
  }
  return { interaction, spendEvents };
};

const maxSpendEventId = async (env: Env) => {
  try {
    const row = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM rag_ai_spend_events").first<{ max_id: number }>();
    return row?.max_id ?? 0;
  } catch {
    return 0;
  }
};

// Simulations run one at a time: loadConfig caches per isolate, and the
// override namespace is swapped in around each run.
let queue: Promise<unknown> = Promise.resolve();
const serialize = <T>(task: () => Promise<T>): Promise<T> => {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
};

const devEnv = (env: Env, overrides: ConfigOverrides, exchanges: AiExchange[]): Env => ({
  ...env,
  AI_CONFIG: configNamespace(overrides),
  AI: wrapAiBinding(env.AI, exchanges) as Ai,
});

// --- simulations ---

// The BotConfig a run with these overrides would see (bundled files, or the
// supplied KV snapshot, plus overrides), for display in the UI.
export const resolveDevConfig = (overrides: ConfigOverrides): Promise<BotConfig> =>
  serialize(async () => {
    resetConfigCache();
    try {
      return await loadConfig({ AI_CONFIG: configNamespace(overrides) });
    } finally {
      resetConfigCache();
    }
  });

export type ModelProbeResult = {
  model: string;
  ok: boolean;
  status: number | null;
  responseModel: string | null;
  error: string | null;
  durationMs: number;
  ai: AiExchange[];
};

// A one-token request through the bot's own inference client (so it reproduces
// exactly what a real run would send, gateway-HTTP or Workers AI binding) to
// check a model id is actually servable before chatting with it.
export const probeModel = (env: Env, model: string, options: SimulationOptions = {}): Promise<ModelProbeResult> =>
  serialize(async () => {
    const startedAt = Date.now();
    const bindingExchanges: AiExchange[] = [];
    const runEnv = devEnv(env, {}, bindingExchanges);
    resetConfigCache();
    let config: BotConfig;
    try {
      config = await loadConfig({ AI_CONFIG: configNamespace({}) });
    } finally {
      resetConfigCache();
    }

    let error: string | null = null;
    let responseModel: string | null = null;
    const tapped = await runWithFetchTap(
      async (request) => (new URL(request.url).hostname === "gateway.ai.cloudflare.com" ? withDevMetadata(request) : undefined),
      async () => {
        try {
          const result = await inferenceClient(runEnv).chat({
            model,
            messages: [{ role: "user", content: "Reply with one word." }],
            maxTokens: 1,
            temperature: config.temperature,
            gatewayId: config.gatewayId,
            metadata: { ragbot_kind: "dev_probe" },
          });
          responseModel = isRecord(result) && typeof result.model === "string" ? result.model : null;
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
      },
      options.upstream,
    );
    const ai = [...gatewayExchanges(tapped.calls), ...bindingExchanges];
    const status = ai[0]?.transport === "gateway-http" && isRecord(ai[0].response) && typeof ai[0].response.status === "number"
      ? ai[0].response.status
      : null;
    return { model, ok: error === null, status, responseModel, error, durationMs: Date.now() - startedAt, ai };
  });

export const simulateMention = (
  env: Env,
  input: MentionSimulationInput,
  options: SimulationOptions = {},
): Promise<MentionSimulationResult> =>
  serialize(async () => {
    const startedAt = Date.now();
    const message = buildMentionMessage(input);
    const bindingExchanges: AiExchange[] = [];
    const runEnv = devEnv(env, input.overrides ?? {}, bindingExchanges);

    // Thread modes need a tracked rag_ai_threads row for the channel; channel
    // mode must not have one, or the message resolves as a thread reply.
    const [initialEntry, ...rest] = input.transcript;
    const isThread = input.mode !== "channel";
    if (isThread) {
      const initialPrompt = initialEntry?.role === "user" ? initialEntry.content : input.content;
      await recordAiThread(env, {
        threadId: input.channelId,
        parentChannelId: input.guildId,
        sourceMessageId: input.mode === "thread" ? initialEntry?.id ?? snowflake() : undefined,
        requesterUserId: (initialEntry?.author ?? input.identity).userId,
        requesterUsername: displayName(initialEntry?.author ?? input.identity),
        initialPrompt,
        title: initialPrompt.slice(0, 80),
      });
    } else {
      await env.DB.prepare("DELETE FROM rag_ai_threads WHERE thread_id = ?").bind(input.channelId).run();
    }
    const historyEntries = isThread && initialEntry?.role === "user" ? rest : input.transcript;

    const state: DiscordStubState = {
      channelId: input.channelId,
      guildId: input.guildId,
      isThread,
      history: historyEntries.map((entry) => transcriptToDiscordMessage(entry, input)),
      resolvedUsers: {},
      channelMessages: [],
      edits: [],
      followUps: [],
      threadsCreated: [],
    };

    const spendWatermark = await maxSpendEventId(env);
    resetConfigCache();
    let tapped;
    try {
      tapped = await runWithFetchTap(
        discordStub(state),
        () => handleMessageCreate(message, runEnv, input.botUserId),
        options.upstream,
      );
    } finally {
      resetConfigCache();
    }

    return {
      durationMs: Date.now() - startedAt,
      message,
      replies: state.channelMessages,
      ai: [...gatewayExchanges(tapped.calls), ...bindingExchanges],
      calls: tapped.calls,
      logs: tapped.logs,
      db: await readDbSideEffects(env, message.id, spendWatermark),
    };
  });

const OPTION_TYPE_USER = 6;

export const buildInteraction = (env: Env, input: InteractionSimulationInput): Record<string, unknown> => {
  const resolvedUsers: Record<string, unknown> = {};
  for (const option of input.options) {
    if (option.type === OPTION_TYPE_USER && option.value) {
      const known = input.resolvedUsers?.[option.value];
      resolvedUsers[option.value] = known
        ? authorFor(known)
        : { id: option.value, username: `user_${option.value.slice(-4)}` };
    }
  }
  return {
    id: snowflake(),
    type: 2,
    version: 1,
    application_id: env.DISCORD_APPLICATION_ID,
    token: `dev-interaction-${snowflake()}`,
    guild_id: input.guildId,
    channel_id: input.channelId,
    locale: "en-US",
    member: {
      user: authorFor(input.identity),
      nick: input.identity.nick ?? null,
      roles: [],
    },
    data: {
      id: snowflake(),
      type: 1,
      name: input.command,
      options: input.options.map((option) => ({ name: option.name, type: option.type, value: option.value })),
      ...(Object.keys(resolvedUsers).length > 0 ? { resolved: { users: resolvedUsers } } : {}),
    },
  };
};

export const simulateInteraction = (
  env: Env,
  input: InteractionSimulationInput,
  options: SimulationOptions = {},
): Promise<InteractionSimulationResult> =>
  serialize(async () => {
    const startedAt = Date.now();
    const interaction = buildInteraction(env, input);
    const bindingExchanges: AiExchange[] = [];
    const runEnv = devEnv(env, input.overrides ?? {}, bindingExchanges);
    const state: DiscordStubState = {
      channelId: input.channelId,
      guildId: input.guildId,
      isThread: false,
      history: [],
      resolvedUsers: input.resolvedUsers ?? {},
      channelMessages: [],
      edits: [],
      followUps: [],
      threadsCreated: [],
    };

    // dispatch runs behind waitUntil in production; collect anything it defers
    // so the run only finishes once every side effect has landed.
    const deferred: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        deferred.push(promise);
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    const spendWatermark = await maxSpendEventId(env);
    resetConfigCache();
    let tapped;
    try {
      tapped = await runWithFetchTap(
        discordStub(state),
        async () => {
          await dispatch(interaction as never, runEnv, ctx);
          await Promise.allSettled(deferred);
        },
        options.upstream,
      );
    } finally {
      resetConfigCache();
    }

    return {
      durationMs: Date.now() - startedAt,
      interaction,
      edits: state.edits,
      followUps: state.followUps,
      channelMessages: state.channelMessages,
      threadsCreated: state.threadsCreated,
      ai: [...gatewayExchanges(tapped.calls), ...bindingExchanges],
      calls: tapped.calls,
      logs: tapped.logs,
      db: await readDbSideEffects(env, null, spendWatermark),
    };
  });

export { redactHeaders };
