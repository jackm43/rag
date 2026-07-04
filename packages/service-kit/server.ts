import { authorizeAndForward } from "@rag/authz/forward";
import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { peekEnvelopeOperation } from "@rag/contracts-core";
import {
  actAsResolverFromAuthority,
  decodeIdentityClaims,
  resolverFromEnv,
  verify,
  verifyActAs,
  type ActAsContext,
  type ActAsPublicKeyResolver,
  type ApplicationAuthorityEnv,
  type IdentityContext,
  type PublicKeyResolver,
} from "./identity";
import type { ServiceKitEnv as Env } from "./env";
import type { RequestContext, ServiceRequest } from "./context";
import { logServiceDenial, parseServiceMessage } from "./message";
import { SERVICE_OPERATIONS, SERVICE_ZONE, SYSTEM_SUBJECT, type MachinePrincipal, type Transport } from "./principal";
import { registryEntities } from "./registry";
import { serviceResourceId } from "./manifest";
import { consumeRequestPlacement, serviceHopIntent, type HopIntent } from "./control-plane";

// Receiving side of the service boundary. One pipeline for every transport:
//   1. extract envelope + token from the received body
//   2. verify the identity token (signature, iss in expected, aud == self,
//      exp/iat window, envelope-hash binding) — a cryptographic gate
//   3. registration gate: read the envelope's operation without trusting the
//      payload and refuse any operation this service has not registered
//   4. forwarding authorizer: Cedar service.invoke with the VERIFIED issuer
//      as the principal either forwards into decode or the request exits
//   5. decode + value-validate the envelope (contracts)
// Any failure logs the shared service_denied shape and returns null; nothing
// reaches domain code, and the message is acked/dropped by the caller. On
// success the handler receives the full verified RequestContext (subject and
// delegation chain included) alongside the decoded payload.

export type ServiceServerConfig = {
  // This service: the token audience the verifier requires.
  self: MachinePrincipal;
  // Services whose tokens this boundary will accept.
  expectedIssuers: readonly MachinePrincipal[];
  // The operations this service registers; absent, its own set from the
  // shared registry (SERVICE_OPERATIONS[self]) — the same set its manifest
  // declares from, so registration and enforcement cannot drift.
  operations?: readonly string[];
  // For the registry/control-plane entity snapshot. If both are absent, service
  // authorization has no dynamic topology and denies by default.
  env?: Env;
  entities?: () => Promise<EntityJson[]>;
  resolver?: PublicKeyResolver;
  // Per-transport trust mode. Default is "identity": require a signed
  // identity-context token. "application" is the same signed-token mode, named
  // for cross-application calls that must carry caller + subject/delegation
  // context. "trusted" reads the caller + subject claims WITHOUT verifying a
  // signature: the platform already gates the transport by capability (a service
  // binding or queue producer is only invocable by a worker whose wrangler
  // config declares it), so the binding graph is the authentication and the
  // signed token adds no trust over it. Only for such capability-scoped
  // transports; never for anything an external party can reach.
  transportTrust?: Partial<Record<Transport, "identity" | "application" | "trusted">>;
  authorizeInvoke?: boolean;
  now?: number;
  // Opt-in act-as verification. Off by default, so an ordinary receiver ignores
  // any act-as token entirely (no behaviour change on hops that don't need it).
  // When set, a hop that carries an act-as token has it verified (signature via
  // the issuer application's JWKS, aud == self, expiry, envelope binding) and
  // the verified ActAsContext is attached to the request context; a present-but-
  // invalid token denies. An absent token is allowed unless requireActAs is set.
  verifyActAs?: boolean;
  requireActAs?: boolean;
  // Resolver for act-as issuer keys; defaults to actAsResolverFromAuthority(env)
  // (runtime JWKS fetch from the issuer application's authority DO).
  actAsResolver?: ActAsPublicKeyResolver;
};

export type ServiceServer = {
  receive: <T>(
    body: unknown,
    decode: (bytes: Uint8Array) => T | null,
    transport?: Transport,
  ) => Promise<ServiceRequest<T> | null>;
};

// Capability-gated transports (a service binding or queue producer the platform
// only exposes to workers whose wrangler config declares it) are trusted by
// default: the binding graph authenticates the caller, so the receiver reads
// claims without verifying a signature and no internal signing keys are needed.
// HTTP is reachable by anyone, so it defaults to signature verification.
// Override per transport via config.transportTrust.
const DEFAULT_TRANSPORT_TRUST: Record<Transport, "identity" | "application" | "trusted"> = {
  binding: "trusted",
  queue: "trusted",
  http: "identity",
};

export const createServiceServer = (config: ServiceServerConfig): ServiceServer => {
  const zone = SERVICE_ZONE[config.self];
  const registeredOperations = config.operations ?? SERVICE_OPERATIONS[config.self];
  const deny = (transport: Transport, identity: MachinePrincipal | "unknown", reason: string) =>
    logServiceDenial({ identity, zone, transport }, reason);

  return {
    receive: async (body, decode, transport = "queue") => {
      const fallbackIdentity = config.expectedIssuers[0] ?? "unknown";
      const parsed = parseServiceMessage(body);
      if (!parsed) {
        // Distinct from the post-verify decode failure ("envelope_invalid"):
        // here the received BODY was not a service message at all.
        deny(transport, fallbackIdentity, "body_unparseable");
        return null;
      }
      const envelope = parsed.envelope;
      const trust = config.transportTrust?.[transport] ?? DEFAULT_TRANSPORT_TRUST[transport];
      let identity: IdentityContext;
      if (trust === "trusted") {
        // Capability-trusted transport: the binding graph already guarantees the
        // caller, so read its claims as asserted rather than verifying a token.
        const claims = decodeIdentityClaims(parsed.idToken);
        if (!claims) {
          deny(transport, fallbackIdentity, "identity_malformed");
          return null;
        }
        if (!config.expectedIssuers.includes(claims.iss)) {
          deny(transport, fallbackIdentity, "identity_unknown_issuer");
          return null;
        }
        identity = claims;
      } else {
        const result = await verify(config.resolver ?? resolverFromEnv(config.env), parsed.idToken, {
          expectedAud: config.self,
          expectedIssuers: config.expectedIssuers,
          envelopeBytes: envelope,
          now: config.now,
        });
        if (!result.ok) {
          deny(transport, fallbackIdentity, `identity_${result.reason}`);
          return null;
        }
        identity = result.context;
      }

      const source = identity.iss;

      // Registration gate: a service is a collection of registered operations,
      // so read the envelope's operation from the framed bytes — cheaply, and
      // without trusting the payload — and refuse anything this service has
      // not registered before the authorizer or any decode runs. An issuer
      // allowed to invoke the service still cannot send an operation kind the
      // service does not accept.
      const operation = peekEnvelopeOperation(envelope);
      if (operation === null || !registeredOperations.includes(operation)) {
        deny(transport, source, "operation_unregistered");
        return null;
      }

      const tokenIntent: HopIntent = identity.action && identity.resource && identity.method
        ? {
          action: identity.action,
          resource: identity.resource,
          method: identity.method,
        }
        : serviceHopIntent(config.self, envelope);
      // Placement stays a control on every transport: it is a correlation/replay
      // gate created by the caller's prepare() over a capability-trusted
      // registry hop, independent of caller-signature verification. "trusted"
      // only drops the signature check, not this.
      const placementAllowed = await consumeRequestPlacement({
        env: config.env,
        placementId: identity.placementId,
        requestId: identity.requestId,
        correlationId: identity.correlationId,
        subject: identity.sub ?? SYSTEM_SUBJECT,
        source,
        target: config.self,
        intent: tokenIntent,
      });
      if (!placementAllowed) {
        deny(transport, source, "placement_invalid");
        return null;
      }

      // Opt-in act-as verification: off by default, so ordinary receivers never
      // look at the act-as token. When enabled, verify it against the issuer
      // application's JWKS (aud == self, expiry, envelope binding) and carry the
      // verified context; a present-but-invalid token denies.
      let verifiedActAs: ActAsContext | undefined;
      if (config.verifyActAs || config.requireActAs) {
        if (!parsed.actAsToken) {
          if (config.requireActAs) {
            deny(transport, source, "actas_missing");
            return null;
          }
        } else {
          const actAsResult = await verifyActAs(
            config.actAsResolver ??
              actAsResolverFromAuthority(config.env as unknown as ApplicationAuthorityEnv | undefined),
            parsed.actAsToken,
            { expectedAud: config.self, envelopeBytes: envelope, now: config.now },
          );
          if (!actAsResult.ok) {
            deny(transport, source, `actas_${actAsResult.reason}`);
            return null;
          }
          verifiedActAs = actAsResult.context;
        }
      }

      const finish = () => {
          const payload = decode(envelope);
          if (payload === null) {
            deny(transport, source, "envelope_invalid");
            return null;
          }
          const context: RequestContext = {
            subject: identity.sub ?? SYSTEM_SUBJECT,
            delegates: identity.act ?? [source],
            source,
            target: config.self,
            zone: identity.trustZone ?? SERVICE_ZONE[source],
            transport,
            ...(identity.dpopJkt !== undefined ? { dpopJkt: identity.dpopJkt } : {}),
            ...(identity.sid !== undefined ? { sid: identity.sid } : {}),
            ...(identity.requestId !== undefined ? { requestId: identity.requestId } : {}),
            ...(identity.placementId !== undefined ? { placementId: identity.placementId } : {}),
            ...(identity.correlationId !== undefined ? { correlationId: identity.correlationId } : {}),
            ...(identity.action !== undefined ? { action: identity.action } : {}),
            ...(identity.resource !== undefined ? { resource: identity.resource } : {}),
            ...(identity.method !== undefined ? { method: identity.method } : {}),
            ...(verifiedActAs !== undefined ? { actAs: verifiedActAs } : {}),
          };
          return { context, payload };
      };

      if (config.authorizeInvoke === false) {
        return finish();
      }

      const entities = config.entities ? await config.entities() : config.env ? await registryEntities(config.env) : [];
      return authorizeAndForward(
        {
          principal: { type: "Application", id: source },
          action: "service.invoke",
          resource: { type: "Service", id: serviceResourceId(config.self, operation) },
          // The operation rides in context so the registered-hop policy can
          // permit only the operations the receiving service registers, not
          // merely the service-level pairing.
          context: { operation },
        },
        {
          entities,
          deny: () => deny(transport, source, "not_authorized"),
        },
        finish,
      );
    },
  };
};
