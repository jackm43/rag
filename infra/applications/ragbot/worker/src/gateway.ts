import { errorMessage, logger } from "../../../../sdk/ts/src";
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
const GATEWAY_WATCHDOG_INTERVAL_MS = 60_000;

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
  private webSocket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;
  private heartbeatAcknowledged = true;
  private messageChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.blockConcurrencyWhile?.(async () => {
      this.botUserId = (await this.state.storage.get<string>(BOT_USER_ID_KEY)) ?? null;
      if (await this.isGatewayEnabled()) {
        await this.scheduleWatchdog();
        this.resetConnection();
      }
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/gateway/health" && request.method === "GET") {
      return Response.json({
        connected: this.webSocket?.readyState === WebSocket.OPEN,
        resumable: Boolean(this.sessionId && this.resumeGatewayUrl),
        botUserId: this.botUserId,
      });
    }

    if (url.pathname === "/gateway/start" && request.method === "POST") {
      await this.enableGateway();
      await this.ensureBotUserId();
      this.resetConnection();
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    if (!(await this.isGatewayEnabled())) {
      return;
    }

    this.reconnectTimer = undefined;
    if (this.webSocket?.readyState !== WebSocket.OPEN || !this.heartbeatAcknowledged) {
      this.resetConnection();
    }
    await this.scheduleWatchdog();
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

  private connect() {
    if (this.webSocket?.readyState === WebSocket.OPEN || this.webSocket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const webSocket = new WebSocket(this.resumeGatewayUrl ?? DISCORD_GATEWAY_URL);
    this.webSocket = webSocket;
    webSocket.addEventListener("message", (event) => {
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(event))
        .catch((error) => {
          logger.error("gateway_message_failed", { error: errorMessage(error) });
        });
    });
    webSocket.addEventListener("close", () => {
      this.clearHeartbeat();
      this.webSocket = null;
      this.scheduleReconnect();
    });
    webSocket.addEventListener("error", () => {
      this.scheduleReconnect();
    });
  }

  private resetConnection() {
    this.clearHeartbeat();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.webSocket?.readyState === WebSocket.OPEN || this.webSocket?.readyState === WebSocket.CONNECTING) {
      this.webSocket.close(4000, "reconnect");
    }
    this.webSocket = null;
    this.connect();
  }

  private async handleMessage(event: MessageEvent) {
    const payload = JSON.parse(String(event.data)) as DiscordGatewayPayload;
    if (typeof payload.s === "number") {
      this.lastSequence = payload.s;
    }

    if (payload.op === 10 && isRecord(payload.d)) {
      this.startHeartbeat(payload.d as DiscordGatewayHello);
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
      this.resetConnection();
      return;
    }

    if (payload.op === 9) {
      if (payload.d !== true) {
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        this.lastSequence = null;
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
      if (ready.user?.id) {
        this.botUserId = ready.user.id;
        await this.state.storage.put(BOT_USER_ID_KEY, ready.user.id);
      }
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
        this.resetConnection();
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

  private scheduleReconnect() {
    if (this.reconnectTimer !== undefined) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.resetConnection();
    }, 5_000);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
