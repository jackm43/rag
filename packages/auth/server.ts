import { authorizeAndForward } from "../authz/forward";
import { keyringResolver, verify, type PublicKeyResolver } from "../identity";
import type { Env } from "../contracts/types";
import type { RequestContext, ServiceRequest } from "./context";
import { logServiceDenial, parseServiceMessage } from "./message";
import { SERVICE_ZONE, type MachinePrincipal, type Transport } from "./principal";
import { registryEntities } from "./registry";

// Receiving side of the service boundary. One pipeline for every transport:
//   1. extract envelope + token from the received body
//   2. verify the identity token (signature, iss in expected, aud == self,
//      exp/iat window, envelope-hash binding) — a cryptographic gate
//   3. forwarding authorizer: Cedar service.invoke with the VERIFIED issuer
//      as the principal either forwards into decode or the request exits
//   4. decode + value-validate the envelope (contracts)
// Any failure logs the shared service_denied shape and returns null; nothing
// reaches domain code, and the message is acked/dropped by the caller. On
// success the handler receives the full verified RequestContext (subject and
// delegation chain included) alongside the decoded payload.

export type ServiceServerConfig = {
  // This service: the token audience the verifier requires.
  self: MachinePrincipal;
  // Services whose tokens this boundary will accept.
  expectedIssuers: readonly MachinePrincipal[];
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
  const deny = (transport: Transport, identity: MachinePrincipal | "unknown", reason: string) =>
    logServiceDenial({ identity, zone, transport }, reason);

  return {
    receive: async (body, decode, transport = "queue") => {
      const fallbackIdentity = config.expectedIssuers[0] ?? "unknown";
      const parsed = parseServiceMessage(body);
      if (!parsed) {
        deny(transport, fallbackIdentity, "envelope_invalid");
        return null;
      }

      if (parsed.idToken === null) {
        deny(transport, fallbackIdentity, "identity_missing");
        return null;
      }
      const envelope = parsed.envelope;

      const result = await verify(config.resolver ?? keyringResolver, parsed.idToken, {
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
      const entities = config.env ? await registryEntities(config.env) : [];
      return authorizeAndForward(
        {
          principal: { type: "Machine", id: source },
          action: "service.invoke",
          resource: { type: "Service", id: config.self },
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
          };
          return { context, payload };
        },
      );
    },
  };
};
