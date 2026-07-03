-- Better Auth core schema for the dev-proxy's application-identity layer
-- (Discord OAuth login behind Cloudflare Access). Generated from Better Auth's
-- own schema definition (better-auth getMigrations → compileMigrations, sqlite
-- dialect) so it matches exactly what the runtime adapter reads/writes.
--
-- Applied to the standalone `ragbot-auth` D1 database, kept separate from the
-- gateway's `ragbot` operational database so login/session state never mingles
-- with product data. The operator applies it out-of-band (Better Auth does not
-- migrate at runtime — D1 forbids the sqlite_master introspection its migrator
-- needs):
--
--   wrangler d1 migrations apply ragbot-auth -c workers/public/dev-proxy/wrangler.jsonc --remote
--   (drop --remote for a local miniflare D1)

create table "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" integer not null,
  "image" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

create table "session" (
  "id" text not null primary key,
  "expiresAt" date not null,
  "token" text not null unique,
  "createdAt" date not null,
  "updatedAt" date not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade,
  -- Perimeter binding: the Cloudflare Access subject this session was created
  -- under (stamped by the Better Auth session create hook, see src/auth.ts).
  -- The command gate requires it to equal the request's live Access identity,
  -- so a session cookie is unusable under a different Access identity.
  "accessSub" text
);

create table "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

create table "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" date not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
