import { DurableObject } from "cloudflare:workers";
import { type Peer, loadLogic, runLogic } from "./logic";
import { type Env, type Member, idPattern, json, readJSON } from "./types";

type Tag = { room: string; peer: Peer; app: string; revision: number };
type Stored = { version: number; state: unknown };
type Wake = { at: number; app: string; revision: number };

export const roomName = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MESSAGE = 64 * 1024;
const MAX_STATE = 128 * 1024;
const MAX_PEERS = 64;
const SERVER: Peer = {
  sid: "server",
  id: "server",
  name: "Server",
  avatar: null,
};

// One instance per app holds every room's sockets and state, so deleting an
// app is a single deleteAll(). The Worker authenticates the member before
// forwarding; this object is never reachable directly.
//
// Without server logic, clients own the shared state and messages are relayed
// between them. With server/room.js, the app's logic receives every join,
// leave, message and tick, owns the public state, keeps a private `secret`,
// and messages players individually.
export class Rooms extends DurableObject<Env> {
  private locks = new Map<string, Promise<unknown>>();

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
    const app = request.headers.get("x-app") ?? "";
    const revision = Number(request.headers.get("x-revision")) || 0;
    if (!roomName.test(room) || !member || !idPattern.test(app))
      return json({ error: "invalid_room" }, 400);
    const logic = revision ? await loadLogic(this.env, app, revision) : null;
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
      return this.join(room, member, app, revision, Boolean(logic));
    if (request.method === "GET")
      return json({ ...(await this.load(room)), peers: this.peers(room) });
    if (request.method !== "PUT")
      return json({ error: "method_not_allowed" }, 405);
    if (logic) return json({ error: "server_owned" }, 409);
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
    const tag = socket.deserializeAttachment() as Tag;
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
    const ref =
      typeof message?.ref === "string" ? message.ref.slice(0, 64) : undefined;
    const logic = tag.revision
      ? await loadLogic(this.env, tag.app, tag.revision)
      : null;
    if (logic) {
      if (message?.t === "send")
        await this.react(tag, "message", {
          peer: tag.peer,
          data: message.data,
          origin: socket,
        });
      else if (message?.t === "set")
        send(socket, { t: "error", error: "server_owned", ref });
      return;
    }
    if (message?.t === "send") {
      const out = JSON.stringify({
        t: "message",
        from: tag.peer,
        data: message.data,
      });
      for (const other of this.ctx.getWebSockets(tag.room)) {
        const target = (other.deserializeAttachment() as Tag).peer;
        if (other !== socket && (!message.to || target.sid === message.to))
          send(other, out);
      }
    } else if (message?.t === "set") {
      const result = await this.write(
        tag.room,
        message.state,
        message.version,
        tag.peer,
        ref,
      );
      if ("error" in result && result.error !== "conflict")
        send(socket, { t: "error", error: result.error, ref });
      else if ("error" in result)
        send(socket, {
          t: "state",
          ...(await this.load(tag.room)),
          conflict: true,
          ref,
        });
    }
  }

  async webSocketClose(socket: WebSocket) {
    await this.left(socket);
  }

  async webSocketError(socket: WebSocket) {
    await this.left(socket);
  }

  /** Deliver due `tick`s. Rooms nobody is connected to stop ticking. */
  async alarm() {
    const wakes = await this.ctx.storage.list<Wake>({ prefix: "wake:" });
    for (const [key, wake] of wakes) {
      if (wake.at > Date.now()) continue;
      await this.ctx.storage.delete(key);
      const room = key.slice(5);
      if (!this.ctx.getWebSockets(room).length) continue;
      await this.react(
        { room, peer: SERVER, app: wake.app, revision: wake.revision },
        "tick",
        {},
      );
    }
    await this.schedule();
  }

  private async join(
    room: string,
    member: Member,
    app: string,
    revision: number,
    server: boolean,
  ) {
    if (this.ctx.getWebSockets(room).length >= MAX_PEERS)
      return json({ error: "room_full" }, 429);
    const { 0: client, 1: socket } = new WebSocketPair();
    const peer: Peer = { ...member, sid: crypto.randomUUID().slice(0, 8) };
    const others = this.peers(room);
    const tag: Tag = { room, peer, app, revision };
    this.ctx.acceptWebSocket(socket, [room]);
    socket.serializeAttachment(tag);
    send(socket, {
      t: "welcome",
      you: peer,
      peers: [...others, peer],
      server,
      ...(await this.load(room)),
    });
    this.broadcast(room, { t: "join", peer }, socket);
    if (server) await this.react(tag, "join", { peer, origin: socket });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async left(socket: WebSocket) {
    const tag = socket.deserializeAttachment() as Tag | null;
    if (!tag) return;
    this.broadcast(tag.room, { t: "leave", peer: tag.peer }, socket);
    if (tag.revision && (await loadLogic(this.env, tag.app, tag.revision)))
      await this.react(tag, "leave", { peer: tag.peer, except: socket });
  }

  /** Run one event through the app's logic and apply the outcome, one at a time per room. */
  private react(
    where: Tag,
    type: "join" | "leave" | "message" | "tick",
    {
      peer,
      data,
      origin,
      except,
    }: { peer?: Peer; data?: unknown; origin?: WebSocket; except?: WebSocket },
  ) {
    const { room, app, revision } = where;
    return this.serialize(room, async () => {
      const logic = await loadLogic(this.env, app, revision);
      if (!logic) return;
      const stored = await this.load(room);
      const secret =
        (await this.ctx.storage.get<Record<string, unknown>>(
          "secret:" + room,
        )) ?? {};
      let outcome;
      try {
        outcome = await runLogic(logic, {
          type,
          room,
          now: Date.now(),
          peers: this.peers(room, except),
          peer,
          data,
          state: stored.state,
          secret,
        });
      } catch {
        // The app's code threw, timed out or returned something unusable: no change.
        if (origin) send(origin, { t: "error", error: "server_error" });
        return;
      }
      await this.ctx.storage.put("secret:" + room, outcome.secret);
      if (JSON.stringify(outcome.state) !== JSON.stringify(stored.state)) {
        const next: Stored = {
          version: stored.version + 1,
          state: outcome.state,
        };
        await this.ctx.storage.put("room:" + room, next);
        this.broadcast(room, { t: "state", ...next, by: SERVER });
      }
      for (const message of outcome.messages) {
        const out = JSON.stringify({
          t: "message",
          from: SERVER,
          data: message.data,
        });
        for (const socket of this.ctx.getWebSockets(room))
          if (
            !message.to ||
            (socket.deserializeAttachment() as Tag).peer.sid === message.to
          )
            send(socket, out);
      }
      if (outcome.wake !== null) {
        await this.ctx.storage.put("wake:" + room, {
          at: Date.now() + outcome.wake,
          app,
          revision,
        } satisfies Wake);
        await this.schedule();
      }
    });
  }

  // Logic calls leave the input gate open; keep each room's events in order.
  private serialize<T>(room: string, task: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(room) ?? Promise.resolve()).then(task, task);
    const settled = result.catch(() => {});
    this.locks.set(room, settled);
    settled.then(() => {
      if (this.locks.get(room) === settled) this.locks.delete(room);
    });
    return result;
  }

  private async schedule() {
    const wakes = await this.ctx.storage.list<Wake>({ prefix: "wake:" });
    const next = Math.min(...[...wakes.values()].map((wake) => wake.at));
    if (Number.isFinite(next))
      await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
    else await this.ctx.storage.deleteAlarm();
  }

  private peers(room: string, except?: WebSocket) {
    return this.ctx
      .getWebSockets(room)
      .filter((socket) => socket !== except)
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
