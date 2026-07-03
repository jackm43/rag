import { authorizeAndForward } from "../authz/forward";
import { peekEnvelopeOperation } from "../contracts";
import { resolverFromEnv, verify, type PublicKeyResolver } from "../identity";
import type { Env } from "../contracts/types";
import type { RequestContext, ServiceRequest } from "./context";
import { logServiceDenial, parseServiceMessage } from "./message";
import { SERVICE_OPERATIONS, SERVICE_ZONE, type MachinePrincipal, type Transport } from "./principal";
import { registryEntities } from "./registry";

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
  // For the registry entity snapshot; absent, static policies decide.
  env?: Env;
  resolver?: PublicKeyResolver;
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

      if (parsed.idToken === null) {
        deny(transport, fallbackIdentity, "identity_missing");
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

      // The verified issuer is the cryptographically-trusted machine
      // principal Cedar decides on; the subject and delegation chain ride in
      // the verified context for downstream attribution.
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

      const entities = config.env ? await registryEntities(config.env) : [];
      return authorizeAndForward(
        {
          principal: { type: "Machine", id: source },
          action: "service.invoke",
          resource: { type: "Service", id: config.self },
          // The operation rides in context so the registered-hop policy can
          // permit only the operations the receiving service registers, not
          // merely the service-level pairing.
          context: { operation },
        },
        {
          entities,
          deny: () => deny(transport, source, "not_authorized"),
        },
        () => {
          const payload = decode(envelope);
          if (payload === null) {
            deny(transport, source, "envelope_invalid");
            return null;
          }
          const context: RequestContext = {
            subject: result.context.sub,
            delegates: result.context.act,
            source,
            target: config.self,
            zone: result.context.trustZone,
            transport,
            ...(result.context.dpopJkt !== undefined ? { dpopJkt: result.context.dpopJkt } : {}),
            ...(result.context.sid !== undefined ? { sid: result.context.sid } : {}),
          };
          return { context, payload };
        },
      );
    },
  };
};
