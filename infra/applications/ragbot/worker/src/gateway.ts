import { errorMessage, logger, resolveSecret } from "@platy/sdk";
import { fetchBotUserId } from "./discord";
import { handleGatewayMessageCreate } from "./mention";
import type { DiscordMessage, Env } from "./types";

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

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const MESSAGE_CONTENT_INTENT = 1 << 15;
const GATEWAY_INTENTS = GUILD_MESSAGES_INTENT | DIRECT_MESSAGES_INTENT | MESSAGE_CONTENT_INTENT;
const GATEWAY_ENABLED_KEY = "gatewayEnabled";
const BOT_USER_ID_KEY = "botUserId";
const SESSION_ID_KEY = "gatewaySessionId";
const RESUME_GATEWAY_URL_KEY = "gatewayResumeUrl";
const LAST_SEQUENCE_KEY = "gatewayLastSequence";
const GATEWAY_WATCHDOG_INTERVAL_MS = 60_000;
const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Gateway control routes on the Durable Object are only reachable through the
// worker binding after Connect RPC authentication in GatewayControlService.
export const forwardToGateway = (request: Request, env: Env, path: string) => {
  const id = env.DISCORD_GATEWAY.idFromName("discord-gateway");
  const url = new URL(request.url);
  url.pathname = path;
  return env.DISCORD_GATEWAY.get(id).fetch(new Request(url, request));
};

export class DiscordGateway {
  private activeSocket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private firstHeartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;
  private heartbeatAcknowledged = true;
  private heartbeatIntervalMs: number | null = null;
  private lastHeartbeatSentAt: number | null = null;
  private reconnectAttempt = 0;
  private messageChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.blockConcurrencyWhile?.(async () => {
      await this.restoreState();
      if (await this.isGatewayEnabled()) {
        await this.scheduleWatchdog();
        this.ensureConnected();
      }
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/gateway/health" && request.method === "GET") {
      return Response.json({
        connected: this.activeSocket?.readyState === WebSocket.OPEN,
        resumable: Boolean(this.sessionId && this.resumeGatewayUrl),
        botUserId: this.botUserId,
      });
    }

    if (url.pathname === "/gateway/start" && request.method === "POST") {
      await this.enableGateway();
      await this.ensureBotUserId();
      if (this.isHealthy()) {
        return Response.json({ ok: true, alreadyConnected: true });
      }
      this.resetConnection();
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    if (!(await this.isGatewayEnabled())) {
      return;
    }

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const connecting = this.activeSocket?.readyState === WebSocket.CONNECTING;
    if (connecting) {
      await this.scheduleWatchdog();
      return;
    }

    if (this.activeSocket?.readyState !== WebSocket.OPEN || this.isHeartbeatStale()) {
      this.resetConnection();
    }
    await this.scheduleWatchdog();
  }

  private async restoreState() {
    this.botUserId = (await this.state.storage.get<string>(BOT_USER_ID_KEY)) ?? null;
    this.sessionId = (await this.state.storage.get<string>(SESSION_ID_KEY)) ?? null;
    this.resumeGatewayUrl = (await this.state.storage.get<string>(RESUME_GATEWAY_URL_KEY)) ?? null;
    const storedSequence = await this.state.storage.get<number>(LAST_SEQUENCE_KEY);
    this.lastSequence = typeof storedSequence === "number" ? storedSequence : null;
  }

  private async persistSessionState() {
    const writes: Promise<void>[] = [];
    if (this.sessionId) {
      writes.push(this.state.storage.put(SESSION_ID_KEY, this.sessionId));
    }
    if (this.resumeGatewayUrl) {
      writes.push(this.state.storage.put(RESUME_GATEWAY_URL_KEY, this.resumeGatewayUrl));
    }
    writes.push(this.state.storage.put(LAST_SEQUENCE_KEY, this.lastSequence));
    await Promise.all(writes);
  }

  private async clearSessionState() {
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.lastSequence = null;
    await Promise.all([
      this.state.storage.delete(SESSION_ID_KEY),
      this.state.storage.delete(RESUME_GATEWAY_URL_KEY),
      this.state.storage.delete(LAST_SEQUENCE_KEY),
    ]);
  }

  private async enableGateway() {
    await this.state.storage.put(GATEWAY_ENABLED_KEY, true);
    await this.scheduleWatchdog();
  }

  private async isGatewayEnabled() {
    return (await this.state.storage.get<boolean>(GATEWAY_ENABLED_KEY)) === true;
  }

  private scheduleWatchdog() {
    return this.state.storage.setAlarm(Date.now() + GATEWAY_WATCHDOG_INTERVAL_MS);
  }

  private isHealthy() {
    if (this.activeSocket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    return !this.isHeartbeatStale();
  }

  private isHeartbeatStale() {
    if (this.heartbeatAcknowledged) {
      return false;
    }
    if (this.lastHeartbeatSentAt === null || this.heartbeatIntervalMs === null) {
      return false;
    }
    return Date.now() - this.lastHeartbeatSentAt >= this.heartbeatIntervalMs;
  }

  private async ensureBotUserId() {
    if (this.botUserId) {
      return this.botUserId;
    }

    const storedId = await this.state.storage.get<string>(BOT_USER_ID_KEY);
    if (storedId) {
      this.botUserId = storedId;
      return storedId;
    }

    const resolved = await fetchBotUserId(this.env);
    if (!resolved) {
      logger.warn("bot_user_id_unavailable");
      return null;
    }

    this.botUserId = resolved;
    await this.state.storage.put(BOT_USER_ID_KEY, resolved);
    return resolved;
  }

  private ensureConnected() {
    if (this.activeSocket?.readyState === WebSocket.OPEN || this.activeSocket?.readyState === WebSocket.CONNECTING) {
      return;
    }
    this.connect();
  }

  private connect() {
    if (this.activeSocket?.readyState === WebSocket.OPEN || this.activeSocket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const url = this.resumeGatewayUrl ?? DISCORD_GATEWAY_URL;
    const webSocket = new WebSocket(url);
    this.activeSocket = webSocket;
    webSocket.addEventListener("message", (event) => {
      if (this.activeSocket !== webSocket) {
        return;
      }
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(event, webSocket))
        .catch((error) => {
          logger.error("gateway_message_failed", { error: errorMessage(error) });
        });
    });
    webSocket.addEventListener("close", () => {
      if (this.activeSocket !== webSocket) {
        return;
      }
      this.activeSocket = null;
      this.clearHeartbeat();
      this.scheduleReconnect();
    });
    webSocket.addEventListener("error", () => {
      if (this.activeSocket !== webSocket) {
        return;
      }
      this.scheduleReconnect();
    });
  }

  private resetConnection() {
    this.clearHeartbeat();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.activeSocket;
    this.activeSocket = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(4000, "reconnect");
    }
    this.connect();
  }

  private async handleMessage(event: MessageEvent, webSocket: WebSocket) {
    if (this.activeSocket !== webSocket) {
      return;
    }

    const payload = JSON.parse(String(event.data)) as DiscordGatewayPayload;
    if (typeof payload.s === "number") {
      this.lastSequence = payload.s;
      await this.persistSessionState();
    }

    if (payload.op === 10 && isRecord(payload.d)) {
      this.startHeartbeat(payload.d as DiscordGatewayHello, webSocket);
      this.identifyOrResume(webSocket);
      return;
    }

    if (payload.op === 11) {
      this.heartbeatAcknowledged = true;
      return;
    }

    if (payload.op === 1) {
      this.sendHeartbeat(webSocket);
      return;
    }

    if (payload.op === 7) {
      this.resetConnection();
      return;
    }

    if (payload.op === 9) {
      if (payload.d !== true) {
        await this.clearSessionState();
      }
      this.resetConnection();
      return;
    }

    if (payload.op !== 0) {
      return;
    }

    if (payload.t === "READY" && isRecord(payload.d)) {
      const ready = payload.d as DiscordGatewayReady;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? this.resumeGatewayUrl;
      this.reconnectAttempt = 0;
      if (ready.user?.id) {
        this.botUserId = ready.user.id;
        await this.state.storage.put(BOT_USER_ID_KEY, ready.user.id);
      }
      await this.persistSessionState();
      logger.info("gateway_ready", { resumable: Boolean(this.resumeGatewayUrl) });
      return;
    }

    if (payload.t === "MESSAGE_CREATE" && isRecord(payload.d)) {
      try {
        const botUserId = await this.ensureBotUserId();
        if (!botUserId) {
          return;
        }
        await handleGatewayMessageCreate(payload.d as DiscordMessage, this.env, botUserId);
      } catch (error) {
        logger.error("gateway_message_create_failed", { error: errorMessage(error) });
      }
    }
  }

  private async identifyOrResume(webSocket: WebSocket) {
    const token = await resolveSecret(this.env.DISCORD_BOT_TOKEN);
    if (this.sessionId && this.resumeGatewayUrl) {
      this.send(webSocket, {
        op: 6,
        d: {
          token,
          session_id: this.sessionId,
          seq: this.lastSequence,
        },
      });
      return;
    }

    this.send(webSocket, {
      op: 2,
      d: {
        token,
        intents: GATEWAY_INTENTS,
        properties: {
          os: "linux",
          browser: "ragbot-worker",
          device: "ragbot-worker",
        },
      },
    });
  }

  private startHeartbeat(hello: DiscordGatewayHello, webSocket: WebSocket) {
    this.clearHeartbeat();
    this.heartbeatIntervalMs = hello.heartbeat_interval;
    this.heartbeatAcknowledged = true;
    const jitterMs = Math.floor(Math.random() * hello.heartbeat_interval);
    this.firstHeartbeatTimer = setTimeout(() => {
      this.firstHeartbeatTimer = undefined;
      if (this.activeSocket !== webSocket || webSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      this.sendHeartbeat(webSocket);
      this.heartbeatTimer = setInterval(() => {
        if (this.activeSocket !== webSocket || webSocket.readyState !== WebSocket.OPEN) {
          this.clearHeartbeat();
          return;
        }
        if (!this.heartbeatAcknowledged) {
          this.resetConnection();
          return;
        }
        this.sendHeartbeat(webSocket);
      }, hello.heartbeat_interval);
    }, jitterMs);
  }

  private sendHeartbeat(webSocket: WebSocket) {
    this.heartbeatAcknowledged = false;
    this.lastHeartbeatSentAt = Date.now();
    this.send(webSocket, { op: 1, d: this.lastSequence });
  }

  private send(webSocket: WebSocket, payload: unknown) {
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(JSON.stringify(payload));
    }
  }

  private reconnectDelayMs() {
    const exponential = MIN_RECONNECT_DELAY_MS * 2 ** Math.min(this.reconnectAttempt, 6);
    const capped = Math.min(MAX_RECONNECT_DELAY_MS, exponential);
    return capped + Math.floor(Math.random() * 1_000);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== undefined) {
      return;
    }
    if (this.activeSocket?.readyState === WebSocket.OPEN || this.activeSocket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const delay = this.reconnectDelayMs();
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureConnected();
    }, delay);
  }

  private clearHeartbeat() {
    if (this.firstHeartbeatTimer !== undefined) {
      clearTimeout(this.firstHeartbeatTimer);
      this.firstHeartbeatTimer = undefined;
    }
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.heartbeatIntervalMs = null;
    this.lastHeartbeatSentAt = null;
    this.heartbeatAcknowledged = true;
  }
}
