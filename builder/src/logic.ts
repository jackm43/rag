import type { Env, Member } from "./types";

// An app's optional server logic (server/room.js, bundled at build time) runs
// in a Dynamic Worker per app revision: no network, no bindings, bounded CPU.
// The Rooms object passes each event in with the room's state and applies what
// comes back, so app code never touches storage or sockets itself.

export type Peer = Member & { sid: string };
export type LogicEvent = {
  type: "join" | "leave" | "message" | "tick";
  room: string;
  now: number;
  peers: Peer[];
  peer?: Peer;
  data?: unknown;
  state: unknown;
  secret: Record<string, unknown>;
};
export type Outcome = {
  state: unknown;
  secret: Record<string, unknown>;
  messages: { to?: string; data: unknown }[];
  wake: number | null;
};
type Logic = { run(event: LogicEvent): Promise<unknown> };

export const LOGIC_LIMITS = {
  state: 128 * 1024,
  secret: 256 * 1024,
  message: 64 * 1024,
  messages: 200,
  wallMs: 2000,
  cpuMs: 100,
};

// The module the host runs; it imports the app's bundle as ./room.js.
const HOST = `import { WorkerEntrypoint } from "cloudflare:workers";
import * as app from "./room.js";
export default class extends WorkerEntrypoint {
  async run(event) {
    const messages = [];
    let wake = null;
    const room = {
      name: event.room,
      now: event.now,
      peers: event.peers,
      state: event.state,
      secret: event.secret,
      send(sid, data) { messages.push({ to: String(sid), data }); },
      broadcast(data) { messages.push({ data }); },
      wakeIn(ms) { wake = Number(ms); },
    };
    const handler = app[event.type];
    if (typeof handler === "function")
      await (event.type === "tick" ? handler(room) : handler(room, event.peer, event.data));
    return JSON.parse(JSON.stringify({ state: room.state ?? null, secret: room.secret ?? {}, messages, wake }));
  }
}`;

const code = new Map<string, string | null>();

/** The app revision's logic, or null when it has none. Code never changes per revision. */
export async function loadLogic(
  env: Env,
  app: string,
  revision: number,
): Promise<Logic | null> {
  const key = `${app}/${revision}`;
  if (!code.has(key)) {
    const object = await env.ARTIFACTS.get(`${key}/server.js`);
    if (code.size > 50) code.delete(code.keys().next().value!);
    code.set(key, object ? await object.text() : null);
  }
  const source = code.get(key);
  if (!source) return null;
  const worker = env.LOADER.get(`app:${app}:${revision}`, () => ({
    compatibilityDate: "2026-08-22",
    mainModule: "host.js",
    modules: { "host.js": HOST, "room.js": source },
    globalOutbound: null,
    env: {},
  }));
  return worker.getEntrypoint(undefined, {
    limits: { cpuMs: LOGIC_LIMITS.cpuMs, subRequests: 0 },
  }) as unknown as Logic;
}

const size = (value: unknown) => JSON.stringify(value ?? null).length;

/** Run one event with a wall-clock bound and check everything the app returns. */
export async function runLogic(
  logic: Logic,
  event: LogicEvent,
): Promise<Outcome> {
  let timer = 0 as unknown as ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("logic_timeout")),
      LOGIC_LIMITS.wallMs,
    );
  });
  let result: any;
  try {
    result = await Promise.race([logic.run(event), timeout]);
  } finally {
    clearTimeout(timer);
  }
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const secret = result?.secret;
  if (
    size(result?.state) > LOGIC_LIMITS.state ||
    typeof secret !== "object" ||
    secret === null ||
    Array.isArray(secret) ||
    size(secret) > LOGIC_LIMITS.secret ||
    messages.length > LOGIC_LIMITS.messages ||
    messages.some(
      (m: any) =>
        size(m?.data) > LOGIC_LIMITS.message ||
        (m?.to !== undefined && typeof m.to !== "string"),
    )
  )
    throw new Error("logic_output_invalid");
  const wake =
    typeof result.wake === "number" && Number.isFinite(result.wake)
      ? Math.min(Math.max(result.wake, 100), 3600_000)
      : null;
  return { state: result.state ?? null, secret, messages, wake };
}
