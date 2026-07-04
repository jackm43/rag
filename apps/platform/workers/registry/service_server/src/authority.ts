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
import { verifyArtifactAttestation } from "../../../../lib/attest-client/client";
import type { Env } from "../../../../contracts";
import { REGISTRY_APPLICATION_ID_PATTERN } from "../../../../lib/registry-kit/types";
import {
  isGrantRequest,
  type GrantArtifact,
  type GrantRequest,
  type GrantStatusResult,
} from "../../../../lib/registry-kit/grants";
import {
  grantStatus as grantStatusEngine,
  GRANT_RETRY_MS,
  submitGrant as submitGrantEngine,
  sweepGrants,
  type GrantDeps,
} from "./grants-engine";

// The per-application authority. Addressed by idFromName(appId), one Durable
// Object instance per registered application, it is that application's OIDC-
// style issuer: it owns the clients registered to act as the application, holds
// the application's signing material, and mints short-lived, envelope-bound
// act-as tokens. It returns only tokens and public keys — the private signing
// key never leaves the DO.
//
// Authorization is grounded in ATTESTATION, not self-assertion. A client is
// registered to act as the application only if the codebase attests it: register()
// verifies (a local match against the AttestationStore — no egress) that the
// registering artifact has a production attestation on record. So "who may act as
// this application" is exactly "what the repo, through CI attestation, says may".
// A member is the RECORD of such an authorized registration; there is no manual
// grant. act-as and on-behalf-of are the same primitive: a registration/mint
// request, authorized first, differing only in the subject it carries.
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

type AuthorityRecord = { appId: string; registeredAt: string };

// The attested artifact a client stakes its registration on — the exact repo
// path + content hash CI attestation covers. Shared with the grant queue.
export type RegistrationArtifact = GrantArtifact;

const isArtifact = (value: unknown): value is RegistrationArtifact => {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.repository === "string" &&
    record.repository.length > 0 &&
    typeof record.path === "string" &&
    record.path.length > 0 &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(record.sha256)
  );
};

// The record of one authorized (attestation-backed) client registration. A
// registered client IS a member — the set the Cedar service.act-as policy reads.
type ClientRegistration = {
  client: string;
  subject?: string;
  artifact: RegistrationArtifact;
  attestedAt: string;
};

export type ApplicationAuthoritySnapshot = {
  appId: string;
  registeredAt: string;
  members: string[];
};

export type ApplicationRegistrationRequest = {
  // The application being registered with / acted as (this DO's identity).
  appId: string;
  // The service/client being registered to act as the application.
  client: string;
  // The production-attested artifact that authorizes the registration.
  artifact: RegistrationArtifact;
  // On-behalf-of subject; act-as the application itself when omitted.
  subject?: string;
};

export type RegistrationFailure = "invalid_request" | "app_mismatch" | "not_attested";

export type ApplicationRegistrationResult =
  | { ok: true; snapshot: ApplicationAuthoritySnapshot }
  | { ok: false; reason: RegistrationFailure };

export type ActAsMintRequest = {
  // The application being acted as — this DO's own identity (idFromName(appId)).
  appId: string;
  // The registered client the token asserts may act as the application.
  member: string;
  // The service the minted token will be presented to (its `aud`).
  audience: string;
  // base64url(SHA-256(envelope bytes)) — binds the token to one payload. The
  // caller hashes the envelope so the payload never reaches the authority.
  envelopeSha256: string;
  // On-behalf-of subject carried as the token `sub`; the application itself
  // (act-as, no distinct subject) when omitted.
  subject?: string;
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
    const stored = await this.ctx.storage.list<ClientRegistration>({ prefix: MEMBER_PREFIX });
    return [...stored.values()].map((record) => record.client).sort();
  }

  // Bind (or re-affirm) this DO's application id and generate its keypair.
  // Registration is when the app's key is mapped — "let the registration happen
  // and map that info then". Idempotent; returns the snapshot or null on a bad id.
  // It does NOT grant members: acting-as rights come only through the
  // attestation-gated register() below.
  async configure(input: unknown): Promise<ApplicationAuthoritySnapshot | null> {
    const appId = await this.bind(asRecord(input)?.appId as string);
    if (!appId) {
      return null;
    }
    await this.ensureSigningMaterial(appId);
    return this.snapshot(appId);
  }

  // Register a client to act as this application, authorized by attestation:
  // the client's artifact must have a production attestation on record (local
  // match against the AttestationStore, no egress). Only then is the client
  // recorded as a member. act-as and on-behalf-of both flow through here — a
  // subject distinguishes on-behalf-of. Idempotent per client.
  async register(input: unknown): Promise<ApplicationRegistrationResult> {
    const record = asRecord(input);
    if (
      !record ||
      !isAppId(record.appId) ||
      !isAppId(record.client) ||
      !isArtifact(record.artifact) ||
      (record.subject !== undefined && (typeof record.subject !== "string" || record.subject.length === 0))
    ) {
      return { ok: false, reason: "invalid_request" };
    }
    const appId = await this.bind(record.appId);
    if (!appId) {
      return { ok: false, reason: "app_mismatch" };
    }

    // Authorize against what the codebase attests: the registering artifact must
    // carry a production attestation. Local match — the attestation arrives via
    // the GitHub webhook and is stored; no outbound fetch here.
    const attested = await verifyArtifactAttestation(this.env, {
      repository: record.artifact.repository,
      path: record.artifact.path,
      sha256: record.artifact.sha256,
      productionOnly: true,
    });
    if (!attested.ok) {
      logger.warn("application_authority_registration_unattested", {
        appId,
        client: record.client,
        repository: record.artifact.repository,
        path: record.artifact.path,
      });
      return { ok: false, reason: "not_attested" };
    }

    await this.recordMember(appId, record.client, record.artifact, record.subject);
    return { ok: true, snapshot: await this.snapshot(appId) };
  }

  // Record an attested client as a member (the set the Cedar service.act-as
  // policy reads) and ensure the application's signing key exists. The caller
  // has already established the attestation; this is the write side shared by
  // the synchronous register() and the event-driven grant path.
  private async recordMember(
    appId: string,
    client: string,
    artifact: GrantArtifact,
    subject?: string,
  ): Promise<void> {
    const registration: ClientRegistration = {
      client,
      ...(subject ? { subject } : {}),
      artifact,
      attestedAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(`${MEMBER_PREFIX}${client}`, registration);
    await this.ensureSigningMaterial(appId);
    logger.info("application_authority_client_registered", { appId, client, subject });
  }

  // Revoke a client registration (control-plane state change; not attestation-gated).
  async removeMember(appId: unknown, member: unknown): Promise<ApplicationAuthoritySnapshot | null> {
    const bound = await this.bind(appId as string);
    if (!bound || !isAppId(member)) {
      return null;
    }
    await this.ctx.storage.delete(`${MEMBER_PREFIX}${member}`);
    logger.info("application_authority_member_removed", { appId: bound, member });
    return this.snapshot(bound);
  }

  // The event-driven grant side. A control-plane grant request (register a
  // client to act as this application, or revoke it) is claimed idempotently on
  // its request id, then applied by the grant engine. A register whose
  // attestation is not yet on record is NOT rejected: it is recorded as pending
  // and the alarm re-checks it until the attestation lands (or the wait times
  // out) — the durable wait the synchronous register() cannot offer, since the
  // attestation arrives via the GitHub webhook after CI. The payload never
  // widens what a member can do: the attestation match is still the sole
  // authorization. This method only validates + binds; the engine owns the
  // state machine so it is testable without a live Durable Object.
  async submitGrant(input: unknown): Promise<GrantStatusResult> {
    if (!isGrantRequest(input)) {
      const requestId = typeof (input as { id?: unknown })?.id === "string" ? (input as { id: string }).id : "";
      return { status: "rejected", requestId, reason: "invalid_request" };
    }
    const appId = await this.bind(input.appId);
    if (!appId) {
      return { status: "rejected", requestId: input.id, reason: "app_mismatch" };
    }
    // The app must have a signing key before it can host members.
    await this.ensureSigningMaterial(appId);
    return submitGrantEngine(this.grantDeps(appId), appId, input);
  }

  // Read the live state of a grant request (the result channel). Unknown ids —
  // never submitted, or already swept after retention — read as "unknown".
  async grantStatus(requestId: unknown): Promise<GrantStatusResult> {
    if (typeof requestId !== "string" || requestId.length === 0) {
      return { status: "unknown", requestId: "" };
    }
    return grantStatusEngine(this.grantDeps(), requestId);
  }

  // The alarm promotes pending registrations whose attestation has landed (or
  // rejects those that waited too long) and sweeps terminal grant records past
  // retention. It reschedules itself only while a registration is still pending,
  // so an idle authority holds no standing alarm. It must never touch signing
  // material or the member set beyond recordMember — the engine guarantees this.
  async alarm(): Promise<void> {
    const deps = this.grantDeps();
    const pendingRemain = await sweepGrants(deps);
    if (pendingRemain) {
      await deps.storage.setAlarm(Date.now() + GRANT_RETRY_MS);
    }
  }

  // Wire the grant engine's injected effects to this DO's storage, attestation
  // client, and member writes. appId is threaded from submitGrant (which has
  // just bound it); grantStatus/alarm read the already-bound id lazily.
  private grantDeps(appId?: string): GrantDeps {
    return {
      storage: this.ctx.storage,
      isAttested: async (artifact) =>
        (
          await verifyArtifactAttestation(this.env, {
            repository: artifact.repository,
            path: artifact.path,
            sha256: artifact.sha256,
            productionOnly: true,
          })
        ).ok,
      recordMember: async (client, artifact, subject) => {
        const bound = appId ?? (await this.boundAppId());
        if (bound) {
          await this.recordMember(bound, client, artifact, subject);
        }
      },
      revokeMember: async (client) => {
        await this.ctx.storage.delete(`${MEMBER_PREFIX}${client}`);
        logger.info("application_authority_member_removed", { appId: appId ?? "", member: client });
      },
      now: () => Date.now(),
    };
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
    const record = asRecord(input);
    if (
      !record ||
      !isAppId(record.appId) ||
      !isAppId(record.member) ||
      !isAppId(record.audience) ||
      typeof record.envelopeSha256 !== "string" ||
      record.envelopeSha256.length === 0 ||
      (record.subject !== undefined && (typeof record.subject !== "string" || record.subject.length === 0))
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

    // sub carries the on-behalf-of subject when present; otherwise the token
    // asserts acting as the application itself (act-as, no distinct subject).
    const subject = typeof record.subject === "string" ? record.subject : appId;
    const context = await buildActAsContext({
      iss: appId,
      sub: subject,
      act: member,
      aud: record.audience,
      envelopeSha256: record.envelopeSha256,
    });
    const token = await mintActAs(key, context);
    logger.info("application_authority_act_as_minted", {
      appId,
      member,
      subject: record.subject,
      audience: record.audience,
      jti: context.jti,
    });
    return { ok: true, token, expiresIn: ACT_AS_TTL_SECONDS };
  }
}
