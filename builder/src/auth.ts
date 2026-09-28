import { DurableObject } from "cloudflare:workers";
import {
  type Env,
  token,
  hash,
  json,
  project,
  idPattern,
  boundedJSON,
  validScope,
} from "./types";
type Session = {
  project: string;
  guild: string;
  user: string;
  access?: string;
  expires: number;
  checked: number;
};
const cookieName = "__Host-rag-session";
export const cookies = (r: Request) =>
  Object.fromEntries(
    (r.headers.get("cookie") || "")
      .split(";")
      .map((s) => s.trim().split("=").slice(0, 2)),
  );
export const cookie = (name: string, value: string, age: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
export function redirect(url: string, values: string[] = []) {
  const headers = new Headers({
    location: url,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  for (const v of values) headers.append("set-cookie", v);
  return new Response(null, { status: 303, headers });
}
export function auth(env: Env) {
  return env.AUTH.get(env.AUTH.idFromName("auth-v1"));
}
export async function authCall(env: Env, path: string, data: unknown) {
  return auth(env).fetch(
    new Request("https://auth" + path, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  );
}
async function member(env: Env, guild: string, user: string, access?: string) {
  const path = access
    ? `users/@me/guilds/${guild}/member`
    : `guilds/${guild}/members/${user}`;
  const r = await fetch(`https://discord.com/api/v10/${path}`, {
    headers: {
      authorization: access
        ? `Bearer ${access}`
        : `Bot ${env.DISCORD_BOT_TOKEN}`,
    },
    redirect: "error",
  });
  if (!r.ok) return false;
  const value = await boundedJSON(r, 100000);
  return value.user?.id === user && !value.pending;
}
export class Auth extends DurableObject<Env> {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const d = await boundedJSON(request, 20000);
    if (path === "/state") {
      const value = { ...d, expires: Date.now() + 600000 };
      const state = token();
      await this.ctx.storage.put("state:" + (await hash(state)), value);
      await this.schedule();
      return json({ state });
    }
    if (path === "/exchange") {
      const key = "state:" + (await hash(d.state || ""));
      const state = await this.ctx.storage.transaction(async (tx) => {
        const s = await tx.get<any>(key);
        await tx.delete(key);
        return s;
      });
      if (!state || state.expires < Date.now() || state.browser !== d.browser)
        return json({}, 403);
      const result = await fetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.env.DISCORD_CLIENT_ID,
          client_secret: this.env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code: d.code,
          redirect_uri: this.env.AUTH_ORIGIN + "/_auth/callback",
        }),
      });
      if (!result.ok) return json({}, 403);
      const tokens = await boundedJSON(result, 10000);
      const who = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        redirect: "error",
      });
      if (!who.ok) return json({}, 403);
      const user = await boundedJSON(who, 10000);
      if (
        !/^\d{17,20}$/.test(user.id) ||
        !(await member(this.env, state.guild, user.id, tokens.access_token))
      )
        return json({}, 403);
      const ticket = token();
      await this.ctx.storage.put("ticket:" + (await hash(ticket)), {
        project: state.project,
        guild: state.guild,
        user: user.id,
        access: tokens.access_token,
        nonce: state.nonce,
        expires: Date.now() + 60000,
        tokenExpires:
          Date.now() + Math.min(Number(tokens.expires_in) || 0, 28800) * 1000,
      });
      return json({ ticket, project: state.project });
    }
    if (path === "/complete") {
      const key = "ticket:" + (await hash(d.ticket || ""));
      const t = await this.ctx.storage.transaction(async (tx) => {
        const t = await tx.get<any>(key);
        if (t && t.project === d.project && t.nonce === d.nonce)
          await tx.delete(key);
        return t;
      });
      if (
        !t ||
        t.project !== d.project ||
        t.nonce !== d.nonce ||
        t.expires < Date.now()
      )
        return json({}, 403);
      return this.session({
        ...t,
        expires: t.tokenExpires,
        checked: Date.now(),
      });
    }
    if (path === "/session") {
      const key = "session:" + (await hash(d.session || ""));
      const s = await this.ctx.storage.get<Session>(key);
      if (!s || s.project !== d.project || s.expires < Date.now())
        return json({}, 401);
      if (Date.now() - s.checked >= 300000) {
        if (!(await member(this.env, s.guild, s.user, s.access))) {
          await this.ctx.storage.delete(key);
          return json({}, 401);
        }
        s.checked = Date.now();
        await this.ctx.storage.put(key, s);
      }
      return json({ user: s.user, guild: s.guild, expires: s.expires });
    }
    if (path === "/logout") {
      await this.ctx.storage.delete("session:" + (await hash(d.session || "")));
      return json({});
    }
    if (path === "/invite") {
      if (!validScope(d, this.env) || !idPattern.test(d.project))
        return json({}, 403);
      const meta = await project(this.env, d.project).fetch(
        new Request("https://project/meta"),
      );
      if (!meta.ok || (await meta.json<any>()).guild_id !== d.guild_id)
        return json({}, 403);
      if (!(await member(this.env, d.guild_id, d.user_id)))
        return json({}, 403);
      const code = token().slice(0, 24);
      await this.ctx.storage.put("code:" + (await hash(code)), {
        project: d.project,
        guild: d.guild_id,
        user: d.user_id,
        expires: Date.now() + 600000,
      });
      await this.schedule();
      return json({ code });
    }
    if (path === "/redeem") {
      // Authentication throttling only; this does not throttle AI requests.
      const bucket = "attempt:" + (await hash(String(d.ip)));
      const attempt = await this.ctx.storage.get<any>(bucket);
      if (attempt && attempt.expires > Date.now() && attempt.count >= 10)
        return json({}, 429);
      await this.ctx.storage.put(bucket, {
        count: attempt && attempt.expires > Date.now() ? attempt.count + 1 : 1,
        expires: Date.now() + 60000,
      });
      const key = "code:" + (await hash(d.code || ""));
      const s = await this.ctx.storage.transaction(async (tx) => {
        const s = await tx.get<any>(key);
        if (s?.project === d.project) await tx.delete(key);
        return s;
      });
      if (
        !s ||
        s.project !== d.project ||
        s.expires < Date.now() ||
        !(await member(this.env, s.guild, s.user))
      )
        return json({}, 403);
      return this.session({
        ...s,
        expires: Date.now() + 8 * 3600000,
        checked: Date.now(),
      });
    }
    return json({}, 404);
  }
  async session(s: Session) {
    const value = token();
    await this.ctx.storage.put("session:" + (await hash(value)), s);
    await this.schedule();
    return json({ session: value });
  }
  async schedule() {
    await this.ctx.storage.setAlarm(Date.now() + 600000);
  }
  async alarm() {
    const entries = await this.ctx.storage.list<any>();
    for (const [key, value] of entries)
      if (value.expires < Date.now()) await this.ctx.storage.delete(key);
    if (entries.size) await this.schedule();
  }
}
export async function authRoute(
  request: Request,
  env: Env,
  projectId?: string,
): Promise<Response | null> {
  const u = new URL(request.url),
    c = cookies(request);
  if (u.origin === env.AUTH_ORIGIN) {
    if (u.pathname === "/_auth/login") {
      const p = u.searchParams.get("project") || "",
        nonce = u.searchParams.get("nonce") || "";
      if (!idPattern.test(p) || !/^[a-f0-9]{64}$/.test(nonce))
        return new Response(null, { status: 400 });
      const r = await project(env, p).fetch(
        new Request("https://project/meta"),
      );
      if (!r.ok) return new Response(null, { status: 404 });
      const meta = await r.json<any>(),
        browser = token();
      if (
        !env.ALLOWED_GUILD_IDS.split(",")
          .map((v) => v.trim())
          .includes(meta.guild_id)
      )
        return new Response(null, { status: 403 });
      const state = await (
        await authCall(env, "/state", {
          project: p,
          guild: meta.guild_id,
          nonce,
          browser,
        })
      ).json<any>();
      const target = new URL("https://discord.com/oauth2/authorize");
      target.search = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        redirect_uri: env.AUTH_ORIGIN + "/_auth/callback",
        response_type: "code",
        scope: "identify guilds.members.read",
        state: state.state,
      }).toString();
      return redirect(target.href, [cookie("__Host-rag-oauth", browser, 600)]);
    }
    if (u.pathname === "/_auth/callback") {
      const r = await authCall(env, "/exchange", {
        state: u.searchParams.get("state"),
        code: u.searchParams.get("code"),
        browser: c["__Host-rag-oauth"],
      });
      if (!r.ok)
        return new Response("Login failed. Please start again.", {
          status: 403,
        });
      const d = await r.json<any>();
      return redirect(
        `https://${d.project}.${env.APP_DOMAIN}/_auth/complete?ticket=${d.ticket}`,
        [cookie("__Host-rag-oauth", "", 0)],
      );
    }
    return new Response(null, { status: 404 });
  }
  if (!projectId) return null;
  if (u.pathname === "/_auth/login") {
    const nonce = token();
    return redirect(
      env.AUTH_ORIGIN +
        "/_auth/login?" +
        new URLSearchParams({ project: projectId, nonce }),
      [cookie("__Host-rag-nonce", nonce, 600)],
    );
  }
  if (u.pathname === "/_auth/complete") {
    const r = await authCall(env, "/complete", {
      project: projectId,
      nonce: c["__Host-rag-nonce"],
      ticket: u.searchParams.get("ticket"),
    });
    if (!r.ok)
      return new Response("Login failed. Please start again.", { status: 403 });
    const d = await r.json<any>();
    return redirect("/", [
      cookie(cookieName, d.session, 28800),
      cookie("__Host-rag-nonce", "", 0),
    ]);
  }
  if (u.pathname === "/_auth/logout" && request.method === "POST") {
    if (request.headers.get("origin") !== u.origin)
      return new Response(null, { status: 403 });
    await authCall(env, "/logout", { session: c[cookieName] });
    return redirect("/", [cookie(cookieName, "", 0)]);
  }
  if (u.pathname === "/_auth/passcode" && request.method === "POST") {
    if (request.headers.get("origin") !== u.origin)
      return new Response(null, { status: 403 });
    if (Number(request.headers.get("content-length") || 0) > 2000)
      return new Response(null, { status: 413 });
    // Bound form bodies before parsing, including chunked requests.
    const reader = request.body?.getReader();
    let raw = "";
    if (reader)
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += new TextDecoder().decode(value);
          if (raw.length > 2000) {
            await reader.cancel();
            return new Response(null, { status: 413 });
          }
        }
      } finally {
        reader.releaseLock();
      }
    const form = new URLSearchParams(raw);
    if (!c["__Host-rag-nonce"] || form.get("nonce") !== c["__Host-rag-nonce"])
      return new Response(null, { status: 403 });
    const r = await authCall(env, "/redeem", {
      project: projectId,
      code: form.get("code"),
      ip: request.headers.get("cf-connecting-ip") || "unknown",
    });
    if (!r.ok)
      return new Response("Code is invalid or expired.", { status: r.status });
    const d = await r.json<any>();
    return redirect("/", [
      cookie(cookieName, d.session, 28800),
      cookie("__Host-rag-nonce", "", 0),
    ]);
  }
  return null;
}
export async function authenticate(request: Request, env: Env, p: string) {
  const r = await authCall(env, "/session", {
    project: p,
    session: cookies(request)[cookieName],
  });
  return r.ok ? r.json<{ user: string; guild: string }>() : null;
}
export function loginPage() {
  const nonce = token();
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Join this guild app</title><style>body{font:18px system-ui;max-width:30rem;margin:12vh auto;padding:2rem;background:#10141d;color:#eee}a,button{display:block;padding:1rem;background:#7289da;color:white;border:0;border-radius:8px;margin:1rem 0}input{padding:.8rem;width:90%}</style><h1>Join this guild app</h1><p>Sign in with Discord to verify your server membership.</p><a href="/_auth/login">Continue with Discord</a><p>Or use your personal code from /buildpass in Discord. Codes expire in ten minutes and work once.</p><form action="/_auth/passcode" method="POST"><input name="code" autocomplete="one-time-code" required maxlength="24"><input type="hidden" name="nonce" value="${nonce}"><button>Use passcode</button></form>`,
    {
      status: 401,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": cookie("__Host-rag-nonce", nonce, 600),
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      },
    },
  );
}
