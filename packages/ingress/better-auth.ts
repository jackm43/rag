import { betterAuth } from "better-auth";

import { cloudflareAccessGuard } from "./cf-access";
import type { IngressEnv as Env } from "./env";

// The dev-proxy's application-identity layer: Better Auth with Discord OAuth,
// running BEHIND Cloudflare Access. Access is the perimeter (does the request
// come from someone in the team?); Better Auth answers the app-level question
// (which Discord user is acting?), and the logged-in user's Discord account id
// becomes the subject the gateway command runs as. Better Auth is authN only —
// Cedar remains the authZ engine on the gateway side.
//
// Per-request instance pattern: a Worker has no module-scope access to its
// bindings (env arrives per fetch), so the instance is built per request from
// env rather than once at module load. betterAuth() is cheap to construct; the
// D1 connection is lazy, so this adds no round-trip until an endpoint touches
// the store.
//
// D1 wiring: Better Auth natively detects a Cloudflare D1 binding (an object
// with batch/exec/prepare) and uses its built-in D1SqliteDialect, resolving the
// database type as sqlite. So we pass the AUTH_DB binding directly — no Kysely
// dialect dependency. The schema is applied out-of-band as a committed D1
// migration (apps/connectors/workers/dev-proxy/api/middleware_client/migrations); Better Auth never introspects
// at runtime (D1 forbids reading sqlite_master, which is why runtime migration
// is not used).

// Config presence is a deploy-time invariant, not a request-time branch: without
// the auth database, secret, base URL, and Discord credentials the app-identity
// layer cannot function, so we fail loudly rather than construct a half-wired
// instance that would deny every session opaquely.
export class AuthUnconfiguredError extends Error {}

export const createAuth = (env: Env) => {
  if (!env.AUTH_DB) {
    throw new AuthUnconfiguredError("AUTH_DB binding is not configured");
  }
  if (!env.BETTER_AUTH_SECRET) {
    throw new AuthUnconfiguredError("BETTER_AUTH_SECRET is not configured");
  }
  if (!env.BETTER_AUTH_URL) {
    throw new AuthUnconfiguredError("BETTER_AUTH_URL is not configured");
  }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    throw new AuthUnconfiguredError("Discord OAuth credentials are not configured");
  }

  return betterAuth({
    // Raw D1 binding → Better Auth's native D1SqliteDialect (see note above).
    database: env.AUTH_DB,
    secret: env.BETTER_AUTH_SECRET,
    // The public origin Access sits in front of; Better Auth derives the OAuth
    // callback (…/api/auth/callback/discord) and session-cookie domain from it.
    baseURL: env.BETTER_AUTH_URL,
    socialProviders: {
      discord: {
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
      },
    },
    session: {
      // Perimeter binding (see the create hook below). Not client-settable
      // (input: false) — only the server hook may stamp it — and read back on
      // every getSession so the command gate can compare it.
      additionalFields: {
        accessSub: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Bind each Better Auth session to the Cloudflare Access identity that
          // created it. A session is minted during the Discord OAuth callback,
          // which the browser makes carrying its Access cookie; we re-verify that
          // Access JWT here (independently of the perimeter guard) and stamp its
          // subject onto the session row. The command gate then refuses any
          // session presented under a different Access identity, so a leaked
          // session cookie is useless to another team member who passes Access as
          // themselves. Fail closed: if Access cannot be verified at creation we
          // throw, and no unbound session is written.
          before: async (session, ctx) => {
            const request = ctx?.request;
            if (!request) {
              throw new AuthUnconfiguredError("session created outside a request context");
            }
            const access = await cloudflareAccessGuard.verify(request, env);
            if (!access.ok) {
              throw new AuthUnconfiguredError("Access identity unverifiable at session creation");
            }
            return { data: { ...session, accessSub: access.grant.identity.sub } };
          },
        },
      },
    },
  });
};

// The concrete Better Auth instance type, inferred from createAuth so it carries
// this worker's exact options (not the wide BetterAuthOptions default).
export type DevProxyAuth = ReturnType<typeof createAuth>;

// Resolve the acting identity from a request's Better Auth session. The session
// identifies a Better Auth user; the Discord *account id* (the snowflake the
// gateway authorizes as) lives on the linked social account, so we read it from
// the user's accounts. `accessSub` is the Cloudflare Access subject the session
// was bound to at creation (see the create hook), which the caller compares
// against the request's live Access identity. Returns null when there is no
// valid session or no linked Discord account — the caller fails closed on null.
export type ResolvedSubject = {
  discordId: string;
  accessSub: string;
  email?: string;
};

export const resolveDiscordSubject = async (
  auth: DevProxyAuth,
  headers: Headers,
): Promise<ResolvedSubject | null> => {
  const session = await auth.api.getSession({ headers });
  if (!session) {
    return null;
  }
  const accounts = await auth.api.listUserAccounts({ headers });
  const discord = accounts.find((account) => account.providerId === "discord");
  if (!discord) {
    return null;
  }
  if (!session.session.accessSub) {
    return null;
  }
  return {
    discordId: discord.accountId,
    accessSub: session.session.accessSub,
    ...(session.user.email ? { email: session.user.email } : {}),
  };
};
