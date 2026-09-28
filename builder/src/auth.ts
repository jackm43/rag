import { DurableObject } from "cloudflare:workers";
import {
  type Env,
  type Member,
  allowedGuilds,
  hash,
  readJSON,
  snowflake,
  token,
} from "./types";

// Discord OAuth is the only way in. Every app is served from one origin, so a
// single login covers all of them. A session only proves who the browser is;
// membership of the app's guild is verified with Discord on first use and at
// least every five minutes after, and any failure denies access.

const DISCORD = "https://discord.com/api/v10";
const SESSION = "__Host-ragbot-session";
const BROWSER = "__Host-ragbot-login";
const SESSION_MS = 8 * 3600_000;
const RECHECK_MS = 5 * 60_000;

type Login = { browser: string; back: string };
type Membership = { member: Member | null; checked: number };
type Session = {
  user: string;
  access: string;
  expires: number;
  guilds: Record<string, Membership>;
};

/** The member's profile if the token's user is a full (non-pending) guild member. */
export async function verifyMember(
  guild: string,
  access: string,
): Promise<Member | null> {
  const response = await fetch(`${DISCORD}/users/@me/guilds/${guild}/member`, {
    headers: { authorization: `Bearer ${access}` },
    redirect: "manual",
  });
  if (!response.ok) return null;
  const member = await readJSON(response, 64 * 1024);
  const user = member?.user;
  if (!user || !snowflake.test(user.id) || member.pending) return null;
  const avatar = member.avatar
    ? `https://cdn.discordapp.com/guilds/${guild}/users/${user.id}/avatars/${member.avatar}.png?size=128`
    : user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
  const name = String(
    member.nick || user.global_name || user.username || "member",
  ).slice(0, 64);
  return { id: user.id, name, avatar };
}

export class Auth extends DurableObject<Env> {
  async begin(login: Login) {
    const state = token();
    await this.put("state:" + (await hash(state)), login, 600_000);
    return state;
  }

  /** Exchange an OAuth code. Returns a session only for members of an allowed guild. */
  async finish(state: string, browser: string, code: string) {
    const login = await this.take<Login>("state:" + (await hash(state)));
    if (!login || !browser || login.browser !== browser) return null;
    const response = await fetch(DISCORD + "/oauth2/token", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.DISCORD_CLIENT_ID,
        client_secret: this.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: new URL("/_auth/callback", this.env.APP_ORIGIN).href,
      }),
    });
    if (!response.ok) return null;
    const grant = await readJSON(response, 16 * 1024);
    if (typeof grant.access_token !== "string") return null;
    if (
      !String(grant.scope || "")
        .split(" ")
        .includes("guilds.members.read")
    )
      return null;
    const guilds: Record<string, Membership> = {};
    let user = "";
    for (const guild of allowedGuilds(this.env)) {
      const member = await verifyMember(guild, grant.access_token);
      guilds[guild] = { member, checked: Date.now() };
      user ||= member?.id ?? "";
    }
    if (!user) return null;
    const expires =
      Date.now() + Math.min(Number(grant.expires_in) * 1000 || 0, SESSION_MS);
    const session = token();
    await this.put(
      "session:" + (await hash(session)),
      { user, access: grant.access_token, expires, guilds } satisfies Session,
      expires - Date.now(),
    );
    return { session, expires, back: login.back };
  }

  /** The session's member profile in `guild`, re-verified with Discord when stale. */
  async member(session: string, guild: string): Promise<Member | null> {
    if (!session) return null;
    const key = "session:" + (await hash(session));
    const value = await this.get<Session>(key);
    if (!value) return null;
    const known = value.guilds[guild];
    if (known && Date.now() - known.checked < RECHECK_MS) return known.member;
    const member = await verifyMember(guild, value.access);
    if (member && member.id !== value.user) return null;
    value.guilds[guild] = { member, checked: Date.now() };
    await this.put(key, value, value.expires - Date.now());
    return member;
  }

  async close(session: string) {
    if (session)
      await this.ctx.storage.delete("session:" + (await hash(session)));
  }

  private async put(key: string, value: object, ttl: number) {
    await this.ctx.storage.put(key, { value, expires: Date.now() + ttl });
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + 600_000);
  }

  private async get<T>(key: string): Promise<T | null> {
    const entry = await this.ctx.storage.get<{ value: T; expires: number }>(
      key,
    );
    return entry && entry.expires > Date.now() ? entry.value : null;
  }

  private async take<T>(key: string): Promise<T | null> {
    const value = await this.get<T>(key);
    await this.ctx.storage.delete(key);
    return value;
  }

  async alarm() {
    const entries = await this.ctx.storage.list<{ expires: number }>();
    const expired = [...entries]
      .filter(([, e]) => e.expires <= Date.now())
      .map(([key]) => key);
    for (let i = 0; i < expired.length; i += 128)
      await this.ctx.storage.delete(expired.slice(i, i + 128));
    if (entries.size > expired.length)
      await this.ctx.storage.setAlarm(Date.now() + 600_000);
  }
}

const auth = (env: Env) => env.AUTH.get(env.AUTH.idFromName("sessions"));

export function cookies(request: Request) {
  const out: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

const cookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}`;

function redirect(location: string, setCookies: string[] = []) {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  for (const value of setCookies) headers.append("set-cookie", value);
  return new Response(null, { status: 303, headers });
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:0;min-height:100dvh;font:17px/1.5 system-ui,sans-serif;background:#1e1f22;color:#f2f3f5}main{max-width:40rem;margin:0 auto;padding:10vh 1.25rem 2rem}.center{text-align:center}a.button,button{display:inline-block;margin-top:1rem;padding:.75rem 1.3rem;border:0;border-radius:8px;background:#5865f2;color:#fff;text-decoration:none;font:inherit;font-weight:600;cursor:pointer}p,small{color:#b5bac1}ul{list-style:none;padding:0}li{margin:.75rem 0;padding:1rem;border-radius:10px;background:#2b2d31}li a{color:#fff;font-weight:600;font-size:1.1rem}header{display:flex;justify-content:space-between;align-items:center;gap:1rem}header button{margin:0;background:#4e5058}</style><main>${body}</main></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export function loginPage(back: string) {
  return page(
    "Sign in",
    `<div class="center"><h1>Members only</h1><p>These apps were built for a Discord server. Sign in with Discord so we can check that you are a member.</p><a class="button" href="/_auth/login?back=${encodeURIComponent(back)}">Continue with Discord</a></div>`,
    401,
  );
}

const denied = () =>
  page(
    "Sign-in failed",
    `<div class="center"><h1>Could not sign you in</h1><p>Only members of the Discord server can use these apps.</p><a class="button" href="/">Try again</a></div>`,
    403,
  );

export function safeBack(value: string | null) {
  return value && /^\/(?!\/)[^\\\s]*$/.test(value) && value.length < 512
    ? value
    : "/";
}

/** Handles /_auth/*; returns null for every other path. */
export async function authRoute(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/_auth/")) return null;
  if (url.pathname === "/_auth/login" && request.method === "GET") {
    const browser = token();
    const state = await auth(env).begin({
      browser,
      back: safeBack(url.searchParams.get("back")),
    });
    const target = new URL("https://discord.com/oauth2/authorize");
    target.search = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      redirect_uri: new URL("/_auth/callback", env.APP_ORIGIN).href,
      response_type: "code",
      scope: "identify guilds.members.read",
      prompt: "none",
      state,
    }).toString();
    return redirect(target.href, [cookie(BROWSER, browser, 600)]);
  }
  if (url.pathname === "/_auth/callback" && request.method === "GET") {
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const result =
      state && code
        ? await auth(env).finish(state, cookies(request)[BROWSER] || "", code)
        : null;
    if (!result) return denied();
    return redirect(result.back, [
      cookie(SESSION, result.session, (result.expires - Date.now()) / 1000),
      cookie(BROWSER, "", 0),
    ]);
  }
  if (url.pathname === "/_auth/logout" && request.method === "POST") {
    if (request.headers.get("origin") !== url.origin)
      return new Response(null, { status: 403 });
    await auth(env).close(cookies(request)[SESSION] || "");
    return redirect("/", [cookie(SESSION, "", 0)]);
  }
  return new Response(null, { status: 404 });
}

/** The verified member for `guild`, or null. */
export function currentMember(request: Request, env: Env, guild: string) {
  return auth(env).member(cookies(request)[SESSION] || "", guild);
}
