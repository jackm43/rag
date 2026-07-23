import { DurableObject } from "cloudflare:workers";

import { handleMessageCreate } from "../events/messageCreate";
import { isDiscordMessage, isRecord, type DiscordMessage } from "../lib/contracts";
import { errorMessage, logger } from "../lib/logger";
import type { Env } from "../env";

type DiscordGatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

type DiscordGatewayHello = {
  heartbeat_interval: number;
};

type DiscordGatewayReady = {
  session_id: string;
  resume_gateway_url?: string;
  user?: {
    id: string;
  };
};

export type DiscordGatewayHealth = {
  connected: boolean;
  resumable: boolean;
};

// Discord requires resumes to reconnect with the same version + encoding query
// params as the initial connect. resume_gateway_url arrives without them, so we
// keep the suffix separate and append it to whichever host we dial.
const GATEWAY_QUERY = "/?v=10&encoding=json";
const DISCORD_GATEWAY_URL = `wss://gateway.discord.gg${GATEWAY_QUERY}`;
const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const MESSAGE_CONTENT_INTENT = 1 << 15;
const GATEWAY_INTENTS = GUILD_MESSAGES_INTENT | DIRECT_MESSAGES_INTENT | MESSAGE_CONTENT_INTENT;
const GATEWAY_ENABLED_KEY = "gatewayEnabled";
// Set only by an explicit operator stop(). ensureConnected() (called by the
// cron trigger) refuses to reconnect while this is set, so automatic wake-ups
// can never resurrect a deliberate kill switch. A manual start() clears it.
const GATEWAY_STOPPED_KEY = "gatewayStopped";
const GATEWAY_WATCHDOG_INTERVAL_MS = 5 * 60_000;
// Per-message dedupe: Discord's at-least-once resume redelivers MESSAGE_CREATE
// across a reconnect, so a processed marker must outlive any in-DO window. Keys
// are pruned by the watchdog alarm once older than this (replaces the old
// InteractionSession.claim()).
const PROCESSED_KEY_PREFIX = "processed:";
const PROCESSED_TTL_MS = 24 * 60 * 60_000;

const isGatewayPayload = (value: unknown): value is DiscordGatewayPayload =>
  isRecord(value) &&
  typeof value.op === "number" &&
  (value.s === undefined || value.s === null || typeof value.s === "number") &&
  (value.t === undefined || value.t === null || typeof value.t === "string");

const isGatewayHello = (value: unknown): value is DiscordGatewayHello =>
  isRecord(value) && typeof value.heartbeat_interval === "number" && value.heartbeat_interval > 0;

const isGatewayReady = (value: unknown): value is DiscordGatewayReady =>
  isRecord(value) &&
  typeof value.session_id === "string" &&
  (value.resume_gateway_url === undefined || typeof value.resume_gateway_url === "string") &&
  (value.user === undefined ||
    (isRecord(value.user) && typeof value.user.id === "string"));

// The one true singleton name. Historical deployments used older names (the
// "-v2" suffix exists for a reason); any object addressed by another name is a
// zombie whose persisted enabled-flag + alarm chain would maintain a SECOND
// Discord session and double-process every mention. Non-canonical instances
// self-decommission (see isCanonicalInstance / decommission).
const GATEWAY_DO_NAME = "discord-gateway-v2";

const gatewayStub = (env: Env) => {
  const id = env.DISCORD_GATEWAY.idFromName(GATEWAY_DO_NAME);
  return env.DISCORD_GATEWAY.get(id) as unknown as DiscordGatewayStub;
};

// The DO's RPC surface, exposed over the DISCORD_GATEWAY binding.
type DiscordGatewayStub = {
  start(): Promise<{ ok: true }>;
  stop(): Promise<{ ok: true }>;
  health(): Promise<DiscordGatewayHealth>;
  ensureConnected(): Promise<{ ok: boolean; stopped?: boolean }>;
};

export const startGateway = async (env: Env) => gatewayStub(env).start();

export const stopGateway = async (env: Env) => gatewayStub(env).stop();

export const getGatewayHealth = async (env: Env) => gatewayStub(env).health();

// Idempotently ensure the gateway websocket is up. Called by the worker's cron
// trigger, so the connection self-establishes after a deploy and self-heals
// without any manual /gateway/start. A no-op while the operator has explicitly
// stopped it, or when the DO binding is absent (e.g. unit tests with a mock env).
export const ensureGatewayConnected = async (env: Env) => {
  if (!env.DISCORD_GATEWAY) {
    return { ok: false as const };
  }
  return gatewayStub(env).ensureConnected();
};

export class DiscordGateway extends DurableObject<Env> {
  private webSocket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;
  private heartbeatAcknowledged = true;
  // Synchronous first-line dedupe so two deliveries racing on the same event loop
  // tick cannot both pass the async storage check. Storage is the durable backstop
  // for redeliveries that span a DO eviction.
  private readonly processedMessageIds = new Set<string>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.blockConcurrencyWhile?.(async () => {
      if (!this.isCanonicalInstance()) {
        await this.decommission();
        return;
      }
      if (await this.isGatewayEnabled()) {
        await this.scheduleWatchdog();
        this.connectGateway();
      }
    });
  }

  // True only for the object addressed by idFromName(GATEWAY_DO_NAME). Stale
  // objects under older names must never hold a gateway session.
  private isCanonicalInstance() {
    // Unit tests construct the DO with a mock env without the binding; treat
    // that as canonical so the mock's behavior is unchanged.
    if (!this.env.DISCORD_GATEWAY?.idFromName) {
      return true;
    }
    return this.ctx.id.equals(this.env.DISCORD_GATEWAY.idFromName(GATEWAY_DO_NAME));
  }

  // Permanently retire a non-canonical instance: wipe the persisted flags and
  // dedupe markers and cancel the alarm chain, so nothing ever wakes it again.
  private async decommission() {
    logger.warn("gateway_stale_instance_decommissioned", { id: this.ctx.id.toString() });
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async health(): Promise<DiscordGatewayHealth> {
    return {
      connected: this.webSocket?.readyState === WebSocket.OPEN,
      resumable: Boolean(this.sessionId && this.resumeGatewayUrl),
    };
  }

  async start() {
    // A manual start clears any operator stop so automatic wake-ups resume.
    // Independent keys, so initiate together and let the output gate coalesce
    // the writes; connectGateway() is synchronous and needs no persisted state.
    await Promise.all([
      this.ctx.storage.delete(GATEWAY_STOPPED_KEY),
      this.enableGateway(),
    ]);
    this.connectGateway();
    return { ok: true as const };
  }

  // Auto-connect entrypoint for the cron trigger. Unless the operator has
  // explicitly stopped the gateway, enable and connect (both idempotent:
  // connectGateway() returns early when already open).
  async ensureConnected() {
    if ((await this.ctx.storage.get<boolean>(GATEWAY_STOPPED_KEY)) === true) {
      return { ok: false, stopped: true };
    }
    await this.enableGateway();
    this.connectGateway();
    return { ok: true };
  }

  // Operator kill switch: clear the enabled flag, cancel the watchdog alarm,
  // close the socket, and forget the resume state so a later start begins with a
  // fresh IDENTIFY. The alarm handler also checks isGatewayEnabled, so even a
  // racing alarm cannot resurrect a stopped gateway.
  async stop() {
    // These writes hit distinct keys/alarm, so initiate them together and let the
    // output gate coalesce them into one durable batch — the operator stop flag
    // marks that ensureConnected() must not bring it back up until a manual
    // start(). Overlaps the (synchronous) socket teardown below; awaited before
    // return so the RPC still confirms durability.
    const persisted = Promise.all([
      this.ctx.storage.delete(GATEWAY_ENABLED_KEY),
      this.ctx.storage.put(GATEWAY_STOPPED_KEY, true),
      this.ctx.storage.deleteAlarm(),
    ]);

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearHeartbeat();

    const webSocket = this.webSocket;
    this.webSocket = null;
    if (webSocket?.readyState === WebSocket.OPEN || webSocket?.readyState === WebSocket.CONNECTING) {
      webSocket.close(1000, "stop");
    }

    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.lastSequence = null;
    await persisted;
    return { ok: true as const };
  }

  async alarm() {
    if (!this.isCanonicalInstance()) {
      await this.decommission();
      return;
    }
    await this.pruneProcessedMarkers();
    if (!(await this.isGatewayEnabled())) {
      return;
    }

    this.connectGateway();
    await this.scheduleWatchdog();
  }

  private async pruneProcessedMarkers() {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    const markers = await this.ctx.storage.list<number>({ prefix: PROCESSED_KEY_PREFIX });
    const stale = [...markers].filter(([, at]) => at <= cutoff).map(([key]) => key);
    if (stale.length > 0) {
      await this.ctx.storage.delete(stale);
    }
  }

  private async enableGateway() {
    // Independent write + alarm: coalesce under the output gate.
    await Promise.all([
      this.ctx.storage.put(GATEWAY_ENABLED_KEY, true),
      this.scheduleWatchdog(),
    ]);
  }

  private async isGatewayEnabled() {
    return (await this.ctx.storage.get<boolean>(GATEWAY_ENABLED_KEY)) === true;
  }

  private scheduleWatchdog() {
    return this.ctx.storage.setAlarm(Date.now() + GATEWAY_WATCHDOG_INTERVAL_MS);
  }

  private connectGateway() {
    if (this.webSocket?.readyState === WebSocket.OPEN || this.webSocket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const webSocket = new WebSocket(
      this.resumeGatewayUrl ? `${this.resumeGatewayUrl}${GATEWAY_QUERY}` : DISCORD_GATEWAY_URL,
    );
    this.webSocket = webSocket;
    webSocket.addEventListener("message", (event) => {
      // Only the current socket handles events. A socket this object has already
      // let go of (a reconnect or a connect race that opened a second socket)
      // must not keep processing — otherwise it double-processes every message.
      // The close/error handlers below guard the same way.
      if (this.webSocket !== webSocket) {
        return;
      }
      void this.handleMessage(event);
    });
    // Ignore events from sockets this object has already let go of (stop() and
    // reconnect() null out this.webSocket first), so a deliberate close does not
    // schedule a reconnect.
    webSocket.addEventListener("close", () => {
      if (this.webSocket !== webSocket) {
        return;
      }
      this.clearHeartbeat();
      this.scheduleReconnect();
    });
    webSocket.addEventListener("error", () => {
      if (this.webSocket !== webSocket) {
        return;
      }
      this.scheduleReconnect();
    });
  }

  private async handleMessage(event: MessageEvent) {
    let payload: DiscordGatewayPayload;
    try {
      const parsed = JSON.parse(String(event.data));
      if (!isGatewayPayload(parsed)) {
        logger.warn("gateway_payload_invalid");
        return;
      }
      payload = parsed;
    } catch (error) {
      logger.warn("gateway_payload_parse_failed", { error: errorMessage(error) });
      return;
    }

    if (typeof payload.s === "number") {
      this.lastSequence = payload.s;
    }

    if (payload.op === 10 && isGatewayHello(payload.d)) {
      this.startHeartbeat(payload.d);
      this.identifyOrResume();
      return;
    }

    if (payload.op === 11) {
      this.heartbeatAcknowledged = true;
      return;
    }

    if (payload.op === 1) {
      this.sendHeartbeat();
      return;
    }

    if (payload.op === 7) {
      this.reconnect();
      return;
    }

    if (payload.op === 9) {
      if (payload.d !== true) {
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        this.lastSequence = null;
      }
      this.reconnect();
      return;
    }

    if (payload.op !== 0) {
      return;
    }

    if (payload.t === "READY" && isGatewayReady(payload.d)) {
      const ready = payload.d;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? this.resumeGatewayUrl;
      this.botUserId = ready.user?.id ?? this.botUserId;
      logger.info("gateway_ready", { resumable: Boolean(this.resumeGatewayUrl) });
      return;
    }

    if (payload.t === "MESSAGE_CREATE" && isDiscordMessage(payload.d)) {
      // Process the mention off the socket read loop: a slow model call or reply
      // must never delay heartbeats or subsequent gateway frames, and a crashed
      // reply must not kill the websocket. All errors are contained inside
      // processMention.
      void this.processMention(payload.d);
    }
  }

  // Dedupe + in-process mention handling. The synchronous Set guard runs before
  // any await so concurrent redeliveries cannot both proceed; the storage marker
  // is the durable backstop for redeliveries spanning a DO eviction. Every error
  // is caught — a failed reply leaves the socket untouched.
  private async processMention(message: DiscordMessage) {
    const messageId = message.id;
    if (this.processedMessageIds.has(messageId)) {
      return;
    }
    this.processedMessageIds.add(messageId);

    const key = `${PROCESSED_KEY_PREFIX}${messageId}`;
    try {
      if ((await this.ctx.storage.get<number>(key)) !== undefined) {
        return;
      }
      await this.ctx.storage.put(key, Date.now());
      await handleMessageCreate(message, this.env, this.botUserId);
    } catch (error) {
      logger.error("gateway_message_create_failed", { error: errorMessage(error) });
    }
  }

  private identifyOrResume() {
    if (this.sessionId && this.resumeGatewayUrl) {
      this.send({
        op: 6,
        d: {
          token: this.env.DISCORD_BOT_TOKEN,
          session_id: this.sessionId,
          seq: this.lastSequence,
        },
      });
      return;
    }

    this.send({
      op: 2,
      d: {
        token: this.env.DISCORD_BOT_TOKEN,
        intents: GATEWAY_INTENTS,
        properties: {
          os: "linux",
          browser: "ragbot-worker",
          device: "ragbot-worker",
        },
      },
    });
  }

  private startHeartbeat(hello: DiscordGatewayHello) {
    this.clearHeartbeat();
    this.heartbeatAcknowledged = true;
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcknowledged) {
        this.reconnect();
        return;
      }
      this.sendHeartbeat();
    }, hello.heartbeat_interval);
  }

  private sendHeartbeat() {
    this.heartbeatAcknowledged = false;
    this.send({ op: 1, d: this.lastSequence });
  }

  private send(payload: unknown) {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(payload));
    }
  }

  private reconnect() {
    this.clearHeartbeat();
    const webSocket = this.webSocket;
    this.webSocket = null;
    if (webSocket?.readyState === WebSocket.OPEN || webSocket?.readyState === WebSocket.CONNECTING) {
      webSocket.close(4000, "reconnect");
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== undefined) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectGateway();
    }, 5_000);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
