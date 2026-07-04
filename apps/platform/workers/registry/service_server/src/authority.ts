import { DurableObject } from "cloudflare:workers";

import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { authorize } from "@rag/authz/authorize";
import {
  ACT_AS_TTL_SECONDS,
  applicationPublicJwk,
  buildActAsContext,
  importSigningKey,
  mintActAs,
} from "@rag/service-kit/identity";
import { errorMessage, logger } from "@rag/logger";
import type { Env } from "../../../../contracts";
import { REGISTRY_APPLICATION_ID_PATTERN } from "../../../../lib/registry-kit/types";

// The per-application authority. Addressed by idFromName(appId), one Durable
// Object instance per registered application, it is that application's OIDC-
// style issuer: it owns the member services allowed to act as the application
// (a Cedar-gated set kept in this DO's datastore, NOT enumerated in code), holds
// the application's signing material, and mints short-lived, envelope-bound
// act-as tokens. It returns only tokens and public keys — the private signing
// key never leaves the DO.
//
// Why self-hosted rather than a Cloudflare-managed OAuth flow: an act-as hop is
// machine-to-machine (one service acting as an application, no human), and every
// Cloudflare-managed OAuth path — Access-for-SaaS OIDC, the workers-oauth-
// provider library, service tokens — is built around a human authorization_code
// consent flow and offers no client_credentials grant. So the authority signs
// the assertion itself (identity/act-as-token.ts) and publishes its verifying
// key via jwks() so any verifier resolves it with off-the-shelf JWKS tooling.
//
// Key custody is fully self-managed: the DO GENERATES its own Ed25519 keypair on
// registration and keeps the private half in its durable storage. No signing key
// is ever manually provisioned or committed, and the private half never leaves
// the DO — only tokens and the public JWK do. A verifier resolves the public key
// at runtime by fetching this jwks() over the binding (actAsResolverFromAuthority),
// so there is no keyring to keep in sync.
//
// This is a separate concern from the ApplicationRegistry directory DO (the
// catalog behind registry.jsmunro.me): the directory answers "what applications
// exist"; the authority answers "who may act as THIS application, and here is a
// token proving it". Keeping them apart avoids re-keying the directory singleton
// (whose list() enumerates every app) and the row backfill that would entail.

const APP_KEY = "authority";
const SIGNING_KEY = "signing";
const MEMBER_PREFIX = "member:";

const ED25519 = { name: "Ed25519" } as const;

type SigningMaterial = { privateJwk: JsonWebKey; publicJwk: JsonWebKey; createdAt: string };

// Members and audiences are open string ids (a MachinePrincipal such as
// "workflows", or another application/connector id); the registry application id
// grammar is the shared, permissive shape for all of them.
const isAppId = (value: unknown): value is string =>
  typeof value === "string" && REGISTRY_APPLICATION_ID_PATTERN.test(value);

type AuthorityRecord = { appId: string; registeredAt: string };
type MemberRecord = { member: string; addedAt: string };

export type ApplicationAuthoritySnapshot = {
  appId: string;
  registeredAt: string;
  members: string[];
};

export type ActAsMintRequest = {
  // The application being acted as — this DO's own identity (idFromName(appId)).
  appId: string;
  // The service the token asserts may act as the application.
  member: string;
  // The service the minted token will be presented to (its `aud`).
  audience: string;
  // base64url(SHA-256(envelope bytes)) — binds the token to one payload. The
  // caller hashes the envelope so the payload never reaches the authority.
  envelopeSha256: string;
};

export type ActAsMintFailure =
  | "invalid_request"
  | "app_mismatch"
  | "not_a_member"
  | "no_signing_key";

export type ActAsMintResult =
  | { ok: true; token: string; expiresIn: number }
  | { ok: false; reason: ActAsMintFailure };

export class ApplicationAuthority extends DurableObject<Env> {
  // The imported private signing key, memoised per instance: import is async and
  // pure, and the DO's own generated key is stable in durable storage.
  private importedKey: CryptoKey | null = null;

  private async boundAppId(): Promise<string | null> {
    const record = await this.ctx.storage.get<AuthorityRecord>(APP_KEY);
    return record?.appId ?? null;
  }

  // Lazily bind this DO instance to its application id on first authenticated
  // use, then enforce every later call names the same app. Because the instance
  // is addressed by idFromName(appId), a mismatch means the caller mis-addressed
  // the DO — refuse rather than serve another app's authority.
  private async bind(appId: string): Promise<string | null> {
    if (!isAppId(appId)) {
      return null;
    }
    const existing = await this.boundAppId();
    if (existing) {
      return existing === appId ? existing : null;
    }
    await this.ctx.storage.put(APP_KEY, {
      appId,
      registeredAt: new Date().toISOString(),
    } satisfies AuthorityRecord);
    return appId;
  }

  // Generate-once, self-managed signing material. On first use the DO mints its
  // own Ed25519 keypair and persists it to durable storage; thereafter it reads
  // the stored key. The private half never leaves the DO. DO method execution is
  // single-threaded per instance, so the generate-if-absent is race-free.
  private async ensureSigningMaterial(appId: string): Promise<{ key: CryptoKey; publicJwk: JsonWebKey }> {
    let stored = await this.ctx.storage.get<SigningMaterial>(SIGNING_KEY);
    if (!stored) {
      const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
      stored = {
        privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
        publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
        createdAt: new Date().toISOString(),
      };
      await this.ctx.storage.put(SIGNING_KEY, stored);
      this.importedKey = null;
      logger.info("application_authority_key_generated", { appId });
    }
    if (!this.importedKey) {
      this.importedKey = await importSigningKey(stored.privateJwk);
    }
    return { key: this.importedKey, publicJwk: stored.publicJwk };
  }

  private async storedPublicJwk(): Promise<JsonWebKey | null> {
    const stored = await this.ctx.storage.get<SigningMaterial>(SIGNING_KEY);
    return stored?.publicJwk ?? null;
  }

  private async listMembers(): Promise<string[]> {
    const stored = await this.ctx.storage.list<MemberRecord>({ prefix: MEMBER_PREFIX });
    return [...stored.values()].map((record) => record.member).sort();
  }

  // Register (or re-affirm) this DO's application id and, optionally, seed its
  // members. Idempotent; returns the current snapshot or null on a bad id.
  async configure(input: unknown): Promise<ApplicationAuthoritySnapshot | null> {
    const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : null;
    const appId = await this.bind(record?.appId as string);
    if (!appId) {
      return null;
    }
    if (Array.isArray(record?.members)) {
      for (const member of record.members) {
        if (isAppId(member)) {
          await this.ctx.storage.put(`${MEMBER_PREFIX}${member}`, {
            member,
            addedAt: new Date().toISOString(),
          } satisfies MemberRecord);
        }
      }
    }
    // Registration is when the app's keypair is generated and mapped — "let the
    // registration happen and map that info then". Idempotent thereafter.
    await this.ensureSigningMaterial(appId);
    return this.snapshot(appId);
  }

  async addMember(appId: unknown, member: unknown): Promise<ApplicationAuthoritySnapshot | null> {
    const bound = await this.bind(appId as string);
    if (!bound || !isAppId(member)) {
      return null;
    }
    await this.ctx.storage.put(`${MEMBER_PREFIX}${member}`, {
      member,
      addedAt: new Date().toISOString(),
    } satisfies MemberRecord);
    logger.info("application_authority_member_added", { appId: bound, member });
    return this.snapshot(bound);
  }

  async removeMember(appId: unknown, member: unknown): Promise<ApplicationAuthoritySnapshot | null> {
    const bound = await this.bind(appId as string);
    if (!bound || !isAppId(member)) {
      return null;
    }
    await this.ctx.storage.delete(`${MEMBER_PREFIX}${member}`);
    logger.info("application_authority_member_removed", { appId: bound, member });
    return this.snapshot(bound);
  }

  private async snapshot(appId: string): Promise<ApplicationAuthoritySnapshot> {
    const record = await this.ctx.storage.get<AuthorityRecord>(APP_KEY);
    return {
      appId,
      registeredAt: record?.registeredAt ?? new Date().toISOString(),
      members: await this.listMembers(),
    };
  }

  async get(): Promise<ApplicationAuthoritySnapshot | null> {
    const appId = await this.boundAppId();
    return appId ? this.snapshot(appId) : null;
  }

  // The application's public verifying key as an RFC 7517 JWK Set, so a receiver
  // of an act-as token this authority issued can resolve the issuer's key by the
  // application id (kid) without holding the private half.
  async jwks(): Promise<{ keys: JsonWebKey[] }> {
    const appId = await this.boundAppId();
    const jwk = await this.storedPublicJwk();
    return appId && jwk ? { keys: [applicationPublicJwk(jwk, appId)] } : { keys: [] };
  }

  // Mint an act-as token: authorize the member against this application's Cedar
  // service.act-as policy (driven by the DO's own members set), then sign the
  // envelope-bound assertion with the application's key. Fails closed with a
  // reason; the private key is never returned.
  async mint(input: unknown): Promise<ActAsMintResult> {
    const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : null;
    if (
      !record ||
      !isAppId(record.appId) ||
      !isAppId(record.member) ||
      !isAppId(record.audience) ||
      typeof record.envelopeSha256 !== "string" ||
      record.envelopeSha256.length === 0
    ) {
      return { ok: false, reason: "invalid_request" };
    }
    const appId = await this.bind(record.appId);
    if (!appId) {
      return { ok: false, reason: "app_mismatch" };
    }

    const member = record.member;
    const members = await this.listMembers();
    const entities: EntityJson[] = [
      {
        uid: { type: "Application", id: appId },
        attrs: {
          members: members.map((id) => ({ __entity: { type: "Application", id } })),
        },
        parents: [],
      },
    ];
    const decision = authorize(
      {
        principal: { type: "Application", id: member },
        action: "service.act-as",
        resource: { type: "Application", id: appId },
      },
      entities,
    );
    if (!decision.allowed) {
      logger.warn("application_authority_act_as_denied", { appId, member, reason: decision.reason });
      return { ok: false, reason: "not_a_member" };
    }

    let key: CryptoKey;
    try {
      ({ key } = await this.ensureSigningMaterial(appId));
    } catch (error) {
      logger.warn("application_authority_key_unavailable", { appId, error: errorMessage(error) });
      return { ok: false, reason: "no_signing_key" };
    }

    const context = await buildActAsContext({
      iss: appId,
      sub: appId,
      act: member,
      aud: record.audience,
      envelopeSha256: record.envelopeSha256,
    });
    const token = await mintActAs(key, context);
    logger.info("application_authority_act_as_minted", {
      appId,
      member,
      audience: record.audience,
      jti: context.jti,
    });
    return { ok: true, token, expiresIn: ACT_AS_TTL_SECONDS };
  }
}
