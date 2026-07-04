import { authorizeAndForward } from "../authz/forward";
import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { peekEnvelopeOperation } from "../contracts";
import { resolverFromEnv, verify, type PublicKeyResolver } from "../identity";
import type { Env } from "../contracts/types";
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
  // context.
  transportTrust?: Partial<Record<Transport, "identity" | "application">>;
  authorizeInvoke?: boolean;
  now?: number;
};

export type ServiceServer = {
  receive: <T>(
    body: unknown,
    decode: (bytes: Uint8Array) => T | null,
    transport?: Transport,
  ) => Promise<ServiceRequest<T> | null>;
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

      const source = result.context.iss;

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

      const tokenIntent: HopIntent = result.context.action && result.context.resource && result.context.method
        ? {
          action: result.context.action,
          resource: result.context.resource,
          method: result.context.method,
        }
        : serviceHopIntent(config.self, envelope);
      const placementAllowed = await consumeRequestPlacement({
        env: config.env,
        placementId: result.context.placementId,
        requestId: result.context.requestId,
        correlationId: result.context.correlationId,
        subject: result.context.sub ?? SYSTEM_SUBJECT,
        source,
        target: config.self,
        intent: tokenIntent,
      });
      if (!placementAllowed) {
        deny(transport, source, "placement_invalid");
        return null;
      }

      const finish = () => {
          const payload = decode(envelope);
          if (payload === null) {
            deny(transport, source, "envelope_invalid");
            return null;
          }
          const context: RequestContext = {
            subject: result.context.sub ?? SYSTEM_SUBJECT,
            delegates: result.context.act ?? [source],
            source,
            target: config.self,
            zone: result.context.trustZone ?? SERVICE_ZONE[source],
            transport,
            ...(result.context.dpopJkt !== undefined ? { dpopJkt: result.context.dpopJkt } : {}),
            ...(result.context.sid !== undefined ? { sid: result.context.sid } : {}),
            ...(result.context.requestId !== undefined ? { requestId: result.context.requestId } : {}),
            ...(result.context.placementId !== undefined ? { placementId: result.context.placementId } : {}),
            ...(result.context.correlationId !== undefined ? { correlationId: result.context.correlationId } : {}),
            ...(result.context.action !== undefined ? { action: result.context.action } : {}),
            ...(result.context.resource !== undefined ? { resource: result.context.resource } : {}),
            ...(result.context.method !== undefined ? { method: result.context.method } : {}),
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
