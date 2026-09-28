import { DurableObject } from "cloudflare:workers";
import { type Env, type Member, json, readJSON } from "./types";

type Peer = Member & { sid: string };
type Tag = { room: string; peer: Peer };
type Stored = { version: number; state: unknown };

export const roomName = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MESSAGE = 64 * 1024;
const MAX_STATE = 128 * 1024;
const MAX_PEERS = 64;

// One instance per app holds every room's sockets and shared state, so deleting
// an app is a single deleteAll(). The Worker authenticates the member before
// forwarding; this object is never reachable directly.
export class Rooms extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'),
    );
  }

  async fetch(request: Request) {
    const room = new URL(request.url).pathname.slice(1);
    const member = JSON.parse(
      request.headers.get("x-member") ?? "null",
    ) as Member;
    if (!roomName.test(room) || !member)
      return json({ error: "invalid_room" }, 400);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
      return this.join(room, member);
    if (request.method === "GET")
      return json({ ...(await this.load(room)), peers: this.peers(room) });
    if (request.method !== "PUT")
      return json({ error: "method_not_allowed" }, 405);
    let body: { version?: unknown; state?: unknown };
    try {
      body = await readJSON(request, MAX_STATE + 1024);
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const result = await this.write(room, body.state, body.version, {
      ...member,
      sid: "http",
    });
    return "error" in result
      ? json(result, result.error === "conflict" ? 409 : 413)
      : json(result);
  }

  async destroy() {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1001, "app_deleted");
      } catch {}
    }
    await this.ctx.storage.deleteAll();
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    const { room, peer } = socket.deserializeAttachment() as Tag;
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) {
      socket.close(1009, "message_too_large");
      return;
    }
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(socket, { t: "error", error: "invalid_json" });
    }
    if (message?.t === "send") {
      const out = JSON.stringify({
        t: "message",
        from: peer,
        data: message.data,
      });
      for (const other of this.ctx.getWebSockets(room)) {
        const target = (other.deserializeAttachment() as Tag).peer;
        if (other !== socket && (!message.to || target.sid === message.to))
          send(other, out);
      }
    } else if (message?.t === "set") {
      const ref =
        typeof message.ref === "string" ? message.ref.slice(0, 64) : undefined;
      const result = await this.write(
        room,
        message.state,
        message.version,
        peer,
        ref,
      );
      if ("error" in result && result.error !== "conflict")
        send(socket, { t: "error", error: result.error, ref });
      else if ("error" in result)
        send(socket, {
          t: "state",
          ...(await this.load(room)),
          conflict: true,
          ref,
        });
    }
  }

  async webSocketClose(socket: WebSocket) {
    this.left(socket);
  }

  async webSocketError(socket: WebSocket) {
    this.left(socket);
  }

  private join(room: string, member: Member) {
    if (this.ctx.getWebSockets(room).length >= MAX_PEERS)
      return json({ error: "room_full" }, 429);
    const { 0: client, 1: server } = new WebSocketPair();
    const peer: Peer = { ...member, sid: crypto.randomUUID().slice(0, 8) };
    const others = this.peers(room);
    this.ctx.acceptWebSocket(server, [room]);
    server.serializeAttachment({ room, peer } satisfies Tag);
    return this.load(room).then((stored) => {
      send(server, {
        t: "welcome",
        you: peer,
        peers: [...others, peer],
        ...stored,
      });
      this.broadcast(room, { t: "join", peer }, server);
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  private left(socket: WebSocket) {
    const tag = socket.deserializeAttachment() as Tag | null;
    if (tag) this.broadcast(tag.room, { t: "leave", peer: tag.peer }, socket);
  }

  private peers(room: string) {
    return this.ctx
      .getWebSockets(room)
      .map((socket) => (socket.deserializeAttachment() as Tag).peer);
  }

  private async load(room: string): Promise<Stored> {
    return (
      (await this.ctx.storage.get<Stored>("room:" + room)) ?? {
        version: 0,
        state: null,
      }
    );
  }

  // Storage calls hold the input gate, so read-compare-write is atomic here.
  private async write(
    room: string,
    state: unknown,
    version: unknown,
    by: Peer,
    ref?: string,
  ) {
    if (JSON.stringify(state ?? null).length > MAX_STATE)
      return { error: "state_too_large" };
    const current = await this.load(room);
    if (version !== undefined && version !== current.version)
      return { error: "conflict" };
    const next: Stored = { version: current.version + 1, state: state ?? null };
    await this.ctx.storage.put("room:" + room, next);
    this.broadcast(room, { t: "state", ...next, by, ref });
    return next;
  }

  private broadcast(room: string, message: unknown, except?: WebSocket) {
    const out = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets(room))
      if (socket !== except) send(socket, out);
  }
}

function send(socket: WebSocket, message: unknown) {
  try {
    socket.send(
      typeof message === "string" ? message : JSON.stringify(message),
    );
  } catch {}
}
