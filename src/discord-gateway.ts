import { enqueueAiChannelPrompt } from "./commands/ai";
import type { DiscordGatewayMessage, Env } from "./types";

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
const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const extractBotMentionPrompt = (content: string, botUserId: string) => {
  const mentionUserId = botUserId.trim();
  if (!mentionUserId) {
    return null;
  }

  const trimmed = content.trim();
  const mentionPattern = new RegExp(`^<@!?${escapeRegExp(mentionUserId)}>(?:\\s+|$)`);
  const match = trimmed.match(mentionPattern);
  if (!match) {
    return null;
  }

  const prompt = trimmed.slice(match[0].length).trim();
  return prompt.length > 0 ? prompt : null;
};

export const handleGatewayMessageCreate = async (
  message: DiscordGatewayMessage,
  env: Env,
  botUserId: string | null,
) => {
  if (message.author?.bot) {
    return;
  }

  if (!botUserId) {
    return;
  }

  const prompt = extractBotMentionPrompt(message.content ?? "", botUserId);
  if (!prompt) {
    return;
  }

  await enqueueAiChannelPrompt(env, message.channel_id, prompt);
};

const hashesMatch = async (actual: string, expected: string) => {
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", actualBytes),
    crypto.subtle.digest("SHA-256", expectedBytes),
  ]);
  const actualDigest = new Uint8Array(actualHash);
  const expectedDigest = new Uint8Array(expectedHash);
  let difference = actualBytes.length ^ expectedBytes.length;
  for (let index = 0; index < actualDigest.length; index += 1) {
    difference |= actualDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
};

const hasGatewayAuthorization = (request: Request, env: Env) =>
  hashesMatch(request.headers.get("authorization") ?? "", `Bearer ${env.DISCORD_BOT_TOKEN}`);

export const handleGatewayControlRequest = (request: Request, env: Env) => {
  const id = env.DISCORD_GATEWAY.idFromName("discord-gateway");
  return env.DISCORD_GATEWAY.get(id).fetch(request);
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

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) { }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/gateway/health" && request.method === "GET") {
      return Response.json({
        connected: this.webSocket?.readyState === WebSocket.OPEN,
        resumable: Boolean(this.sessionId && this.resumeGatewayUrl),
      });
    }

    if (url.pathname === "/gateway/start" && request.method === "POST") {
      if (!(await hasGatewayAuthorization(request, this.env))) {
        return new Response("Unauthorized", { status: 401 });
      }

      this.connect();
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
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
      void this.handleMessage(event);
    });
    webSocket.addEventListener("close", () => {
      this.clearHeartbeat();
      this.scheduleReconnect();
    });
    webSocket.addEventListener("error", () => {
      this.scheduleReconnect();
    });
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

    if (payload.t === "READY" && isRecord(payload.d)) {
      const ready = payload.d as DiscordGatewayReady;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? this.resumeGatewayUrl;
      this.botUserId = ready.user?.id ?? this.botUserId;
      return;
    }

    if (payload.t === "MESSAGE_CREATE" && isRecord(payload.d)) {
      await handleGatewayMessageCreate(payload.d as DiscordGatewayMessage, this.env, this.botUserId);
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
    if (this.webSocket?.readyState === WebSocket.OPEN || this.webSocket?.readyState === WebSocket.CONNECTING) {
      this.webSocket.close(4000, "reconnect");
    }
    this.webSocket = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== undefined) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 5_000);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
